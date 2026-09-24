/**
 * OpenCommander Hub — Cloudflare Worker + Durable Object.
 *
 *   ChatGPT ──HTTPS──▶  /mcp/<MCP_TOKEN>   (stateless MCP, JSON responses)
 *                              │
 *                       Durable Object "hub"
 *                              │  WebSocket (outbound from each machine)
 *              ┌───────────────┴───────────────┐
 *        opencommander agent (PC)      opencommander agent (Laptop)
 *
 * Every tool gets a `machine` argument; the hub forwards the call to that
 * machine's agent and returns its result. Agents connect OUT to the hub, so no
 * tunnel, open port or fixed IP is needed on any machine.
 *
 * Secrets (wrangler secret put): MCP_TOKEN, AGENT_KEY, ADMIN_KEY
 */

const HUB_VERSION = '0.1.0';
const CALL_TIMEOUT_MS = 115_000;
const RPC_TIMEOUT_MS = 10_000;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/' || url.pathname === '/healthz') {
            return json({ ok: true, name: 'opencommander-hub', version: HUB_VERSION });
        }
        const id = env.HUB.idFromName('hub');
        return env.HUB.get(id).fetch(request);
    },
};

// ---------------------------------------------------------------- helpers

function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const ea = new TextEncoder().encode(a); const eb = new TextEncoder().encode(b);
    if (ea.length !== eb.length) return false;
    let diff = 0;
    for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
    return diff === 0;
}

function bearer(request) {
    const h = request.headers.get('Authorization') || '';
    return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

const rid = () => crypto.randomUUID();

const textResult = (obj, isError = false) => ({
    content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }],
    ...(isError ? { isError: true } : {}),
});

const HUB_INSTRUCTIONS = `OpenCommander Hub: one connector that controls several of the user's computers.
Every tool has a "machine" argument — ALWAYS pass it (e.g. "PC" or "Laptop"). Call list_machines (or session_start without machine) to see which machines exist and are online.
If the user does not say which machine, ask once or use the only online machine. Never assume a job/file on one machine exists on another.
Then follow the OpenCommander workflow returned by session_start(machine=...): background jobs for slow work (job_start + job_wait, with request_key), git_checkpoint before edits, repo_verify after edits, task_state_save to survive disconnects.
Risky commands return APPROVAL_REQUIRED: ask the user to approve it in the hub dashboard (<hub>/admin) or on that machine, then repeat the call with approval_id.`;

// ---------------------------------------------------------------- Durable Object

export class Hub {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.pending = new Map(); // id -> { machine, resolve, timer }
        // Answer keep-alive pings without waking the object (cheap on the free plan).
        try { this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch { /* older runtime */ }
    }

    // ------------------------------------------------ routing
    async fetch(request) {
        const url = new URL(request.url);
        const p = url.pathname;
        if (p === '/agent') return this.handleAgent(request, url);
        if (p === '/mcp' || p.startsWith('/mcp/')) return this.handleMcp(request, url);
        if (p === '/admin' || p === '/admin/') return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
        if (p.startsWith('/admin/api/')) return this.handleAdminApi(request, url);
        return json({ error: 'not found' }, 404);
    }

    // ------------------------------------------------ machines
    async machines() {
        const stored = await this.ctx.storage.list({ prefix: 'machine:' });
        const out = [];
        for (const [, m] of stored) {
            const online = this.ctx.getWebSockets(m.name).length > 0;
            out.push({ name: m.name, online, hostname: m.hostname, platform: m.platform, version: m.version, last_seen: m.last_seen, connected_at: online ? m.connected_at : undefined });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    async resolveMachine(requested) {
        const list = await this.machines();
        if (requested) {
            const m = list.find(x => x.name.toLowerCase() === String(requested).trim().toLowerCase());
            if (!m) return { error: `Unknown machine "${requested}". Known machines: ${list.map(x => `${x.name} (${x.online ? 'online' : 'offline'})`).join(', ') || 'none — start "opencommander agent" on a computer first'}.` };
            if (!m.online) return { error: `Machine "${m.name}" is offline (last seen ${m.last_seen || 'never'}). Online: ${list.filter(x => x.online).map(x => x.name).join(', ') || 'none'}. Its background jobs keep running and can be checked when it reconnects.` };
            return { machine: m };
        }
        const online = list.filter(x => x.online);
        if (online.length === 1) return { machine: online[0] };
        if (!online.length) return { error: `No machine is online. Known: ${list.map(x => x.name).join(', ') || 'none'}. Start "opencommander agent" on the computer.` };
        return { error: `Several machines are online (${online.map(x => x.name).join(', ')}). Pass machine="<name>".` };
    }

    // ------------------------------------------------ agents (WebSocket)
    async handleAgent(request, url) {
        if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
        const key = bearer(request) || url.searchParams.get('key') || '';
        if (!safeEqual(key, this.env.AGENT_KEY || '')) return json({ error: 'unauthorized agent' }, 401);
        const name = (url.searchParams.get('name') || '').trim();
        if (!/^[A-Za-z0-9._ -]{1,40}$/.test(name)) return json({ error: 'bad or missing ?name (1-40 chars: letters, digits, . _ - space)' }, 400);

        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        // Tag the socket with the machine name so getWebSockets(name) finds it after hibernation.
        this.ctx.acceptWebSocket(server, [name]);
        const now = new Date().toISOString();
        const prev = await this.ctx.storage.get(`machine:${name}`);
        await this.ctx.storage.put(`machine:${name}`, {
            name,
            hostname: url.searchParams.get('hostname') || prev?.hostname || '',
            platform: url.searchParams.get('platform') || prev?.platform || '',
            version: url.searchParams.get('version') || prev?.version || '',
            connected_at: now,
            last_seen: now,
        });
        server.serializeAttachment({ name });
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, data) {
        let msg;
        try { msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return; }
        const att = ws.deserializeAttachment() || {};
        if (msg.type === 'hello' || msg.type === 'heartbeat') {
            const rec = await this.ctx.storage.get(`machine:${att.name}`);
            if (rec) { rec.last_seen = new Date().toISOString(); await this.ctx.storage.put(`machine:${att.name}`, rec); }
            return;
        }
        // Response to a tool/RPC call we forwarded.
        if (msg.type === 'result' && msg.id) {
            const p = this.pending.get(msg.id);
            if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); p.resolve(msg); }
        }
    }

    async webSocketClose(ws) { await this.markGone(ws); }
    async webSocketError(ws) { await this.markGone(ws); }

    async markGone(ws) {
        const att = ws.deserializeAttachment() || {};
        if (!att.name) return;
        // Only clear connected_at if no other socket for this machine remains.
        if (this.ctx.getWebSockets(att.name).length === 0) {
            const rec = await this.ctx.storage.get(`machine:${att.name}`);
            if (rec) { rec.connected_at = undefined; rec.last_seen = new Date().toISOString(); await this.ctx.storage.put(`machine:${att.name}`, rec); }
        }
    }

    /** Forward one request to a machine's agent and await its reply. */
    forward(machineName, payload, timeoutMs) {
        const sockets = this.ctx.getWebSockets(machineName);
        if (!sockets.length) return Promise.resolve({ error: `machine ${machineName} is offline` });
        const id = rid();
        const message = { ...payload, id };
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                resolve({ timeout: true });
            }, timeoutMs);
            this.pending.set(id, { machine: machineName, resolve, timer });
            try { sockets[0].send(JSON.stringify(message)); } catch (e) {
                clearTimeout(timer); this.pending.delete(id);
                resolve({ error: `send failed: ${e.message}` });
            }
        });
    }
    // ------------------------------------------------ MCP endpoint (ChatGPT)
    async handleMcp(request, url) {
        const pathToken = url.pathname.startsWith('/mcp/') ? decodeURIComponent(url.pathname.slice(5)) : '';
        const token = bearer(request) || pathToken || url.searchParams.get('token') || '';
        if (!safeEqual(token, this.env.MCP_TOKEN || '')) {
            return json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }, 401, { 'WWW-Authenticate': 'Bearer' });
        }
        if (request.method === 'GET' || request.method === 'DELETE') {
            return json({ jsonrpc: '2.0', error: { code: -32000, message: 'stateless server: use POST' }, id: null }, 405, { Allow: 'POST' });
        }
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

        let body;
        try { body = await request.json(); } catch (e) {
            return json({ jsonrpc: '2.0', error: { code: -32700, message: `parse error: ${e.message}` }, id: null }, 400);
        }
        if (Array.isArray(body)) {
            const out = [];
            for (const m of body) { const r = await this.rpc(m); if (r) out.push(r); }
            return json(out);
        }
        const r = await this.rpc(body);
        return r ? json(r) : new Response(null, { status: 202 });
    }

    async rpc(msg) {
        const { id, method, params } = msg || {};
        const reply = (result) => ({ jsonrpc: '2.0', id, result });
        const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
        if (id === undefined || id === null) return null; // notification

        if (method === 'initialize') {
            return reply({
                protocolVersion: params?.protocolVersion || '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'opencommander-hub', version: HUB_VERSION },
                instructions: HUB_INSTRUCTIONS,
            });
        }
        if (method === 'ping') return reply({});
        if (method === 'tools/list') return reply({ tools: await this.toolList() });
        if (method === 'tools/call') return reply(await this.toolCall(params));
        return fail(-32601, `method not found: ${method}`);
    }

    // Ask any online machine for its tool schemas, then add `machine` + expose list_machines.
    async toolList() {
        const list = await this.machines();
        const online = list.find(m => m.online);
        const machineEnum = list.map(m => m.name);
        const machineDesc = `Which computer to run on. Known: ${list.map(m => `${m.name} (${m.online ? 'online' : 'offline'})`).join(', ') || 'none yet'}.`;
        const tools = [{
            name: 'list_machines',
            description: 'List the user\'s computers connected to this hub and whether each is online. Call this (or session_start) first to know what machine names exist before using any other tool.',
            inputSchema: { type: 'object', properties: {} },
            annotations: { title: 'List machines', readOnlyHint: true },
        }];
        if (online) {
            const r = await this.forward(online.name, { type: 'tools/list' }, RPC_TIMEOUT_MS);
            if (r && r.result && Array.isArray(r.result.tools)) {
                for (const t of r.result.tools) {
                    const schema = t.inputSchema && typeof t.inputSchema === 'object' ? { ...t.inputSchema } : { type: 'object', properties: {} };
                    schema.properties = { ...(schema.properties || {}), machine: { type: 'string', description: machineDesc, ...(machineEnum.length ? { enum: machineEnum } : {}) } };
                    tools.push({ ...t, inputSchema: schema });
                }
                return tools;
            }
        }
        // No machine online: still expose a session_start stub so ChatGPT can report status.
        tools.push({
            name: 'session_start',
            description: 'Start/resume a session on a machine. NOTE: no machine is online right now — call list_machines. Start "opencommander agent" on the computer.',
            inputSchema: { type: 'object', properties: { machine: { type: 'string', description: machineDesc } } },
            annotations: { title: 'Start session', readOnlyHint: true },
        });
        return tools;
    }

    async toolCall(params) {
        const name = params?.name;
        const args = (params?.arguments && typeof params.arguments === 'object') ? { ...params.arguments } : {};
        if (name === 'list_machines') {
            return textResult({ machines: await this.machines(), hub_version: HUB_VERSION });
        }
        const requested = args.machine;
        delete args.machine;
        const res = await this.resolveMachine(requested);
        if (res.error) return textResult({ status: 'NO_MACHINE', error: res.error }, true);

        const r = await this.forward(res.machine.name, { type: 'call', name, arguments: args }, CALL_TIMEOUT_MS);
        if (r?.timeout) {
            return textResult({ status: 'HUB_TIMEOUT', machine: res.machine.name, note: `No reply from "${res.machine.name}" within ${Math.round(CALL_TIMEOUT_MS / 1000)}s. For long work use job_start + job_wait so calls return quickly.` }, true);
        }
        if (r?.error) return textResult({ status: 'MACHINE_ERROR', machine: res.machine.name, error: r.error }, true);
        if (r?.result) {
            const result = r.result;
            // Tag the origin machine into the first text block so the model never confuses machines.
            if (Array.isArray(result.content) && result.content[0]?.type === 'text') {
                // leave as-is; machine is clear from the call. (Kept minimal to preserve JSON payloads.)
            }
            return result;
        }
        return textResult({ status: 'MACHINE_ERROR', machine: res.machine.name, error: 'empty response' }, true);
    }

    // ------------------------------------------------ admin (remote approvals)
    async handleAdminApi(request, url) {
        const key = bearer(request) || request.headers.get('X-OC-Admin') || url.searchParams.get('key') || '';
        if (!safeEqual(key, this.env.ADMIN_KEY || '')) return json({ error: 'unauthorized' }, 401);
        const sub = url.pathname.slice('/admin/api/'.length);

        if (request.method === 'GET' && sub === 'state') {
            const machines = await this.machines();
            const approvals = [];
            for (const m of machines.filter(x => x.online)) {
                const r = await this.forward(m.name, { type: 'approvals' }, RPC_TIMEOUT_MS);
                if (r?.result?.pending) for (const a of r.result.pending) approvals.push({ ...a, machine: m.name });
            }
            return json({ machines, approvals });
        }
        const m = /^machines\/([^/]+)\/approvals\/(apr_[a-z0-9]+)\/(approve|deny)$/i.exec(sub);
        if (request.method === 'POST' && m) {
            const machine = decodeURIComponent(m[1]);
            const r = await this.forward(machine, { type: 'decide', approval_id: m[2], decision: m[3] === 'approve' ? 'approved' : 'denied' }, RPC_TIMEOUT_MS);
            if (r?.timeout) return json({ error: 'machine offline' }, 409);
            if (r?.error) return json({ error: r.error }, 409);
            return json(r.result || { ok: true });
        }
        return json({ error: 'not found' }, 404);
    }
}

// ---------------------------------------------------------------- admin dashboard page

const ADMIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenCommander Hub</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--mut:#6b6b66;--card:#fff;--line:#e3e3de;--acc:#2f6f4f;--bad:#a8322d}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecece8;--mut:#9a9a93;--card:#1f1f1d;--line:#33332f;--acc:#6cc497;--bad:#f07b73}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:920px;margin:0 auto;padding:20px 16px}h1{font-size:20px;margin:0 0 2px}h2{font-size:14px;margin:24px 0 8px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:8px 0}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:200px}
input{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:6px 14px;border-radius:8px;cursor:pointer}
button.ok{background:var(--acc);border-color:var(--acc);color:#fff}button.no{color:var(--bad)}
pre{font:12.5px/1.4 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all;background:var(--bg);padding:8px;border-radius:6px;margin:6px 0 0}
.pill{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--mut)}
.pill.online{color:var(--acc);border-color:var(--acc)}.empty{color:var(--mut);padding:8px 2px}
</style></head><body><main>
<h1>OpenCommander Hub</h1><div class="mut">Machines &amp; approvals across your computers</div>
<div class="card"><div class="row"><div class="grow"><label>Admin key <input id="key" type="password" placeholder="ADMIN_KEY" style="width:100%"></label></div><button class="ok" onclick="save()">Connect</button></div></div>
<h2>Machines</h2><div id="machines"><div class="empty">Enter the admin key.</div></div>
<h2>Pending approvals</h2><div id="approvals"></div>
<script>
const g=id=>document.getElementById(id);
let KEY=sessionStorage.getItem('ocadmin')||'';
if(KEY)g('key').value=KEY;
function save(){KEY=g('key').value.trim();sessionStorage.setItem('ocadmin',KEY);load();}
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function api(path,method='GET'){return fetch('/admin/api/'+path,{method,headers:{'X-OC-Admin':KEY}});}
async function act(machine,id,d){await api('machines/'+encodeURIComponent(machine)+'/approvals/'+id+'/'+d,'POST');load();}
async function load(){
 if(!KEY)return;
 let s;try{const r=await api('state');if(!r.ok){g('machines').innerHTML='<div class="empty">'+(r.status===401?'Wrong admin key.':'Error '+r.status)+'</div>';return;}s=await r.json();}catch(e){return;}
 g('machines').innerHTML=s.machines.length?s.machines.map(m=>'<div class="card"><div class="row"><b>'+esc(m.name)+'</b> <span class="pill '+(m.online?'online':'')+'">'+(m.online?'online':'offline')+'</span><span class="mut">'+esc(m.hostname||'')+' · '+esc(m.platform||'')+' · '+esc(m.version||'')+'</span></div></div>').join(''):'<div class="empty">No machines yet. Run "opencommander agent" on a computer.</div>';
 g('approvals').innerHTML=s.approvals.length?s.approvals.map(a=>'<div class="card"><div class="row"><div class="grow"><b>'+esc(a.machine)+'</b> · '+esc(a.tool)+' <span class="mut">'+esc(a.id)+'</span><div>'+(a.reasons||[]).map(r=>'<span class="pill">'+esc(r)+'</span>').join(' ')+'</div></div><button class="ok" onclick="act(\\''+esc(a.machine)+'\\',\\''+a.id+'\\',\\'approve\\')">Approve</button><button class="no" onclick="act(\\''+esc(a.machine)+'\\',\\''+a.id+'\\',\\'deny\\')">Deny</button></div><pre>'+esc((a.summary||'').slice(0,300))+'</pre></div>').join(''):'<div class="empty">Nothing waiting.</div>';
}
if(KEY)load();setInterval(load,3000);
</script></body></html>`;
