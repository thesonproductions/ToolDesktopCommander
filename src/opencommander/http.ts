/**
 * Streamable-HTTP MCP endpoint for ChatGPT (and any remote MCP client).
 *
 * STATELESS by design: every POST gets a fresh MCP Server+transport that
 * shares the same tool handlers. There is no MCP session to lose, so a
 * ChatGPT reconnect, a browser reload or a restart of this process never
 * produces "session not found" errors — the next call simply works, and the
 * persistent job registry carries the long-running state.
 */
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { dirs, ensureConfigFile, getConfig, getOrCreateToken } from './config.js';
import { decide, listApprovals } from './security/approvals.js';
import { listJobs, summarize } from './jobs/manager.js';
import { loadCore, makeCoreServer, redirectConsole } from './core-bridge.js';
import { OC_VERSION } from './tools.js';
import { readAudit } from './audit.js';

function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a); const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req: http.IncomingMessage, limit = 50 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []; let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function send(res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
    res.end(text);
}

function cors(res: http.ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

export interface ServeOptions { host?: string; port?: number; adminPort?: number; noAdmin?: boolean; quiet?: boolean }

export async function serve(opts: ServeOptions = {}) {
    (global as any).__ocTransport = 'http';
    (global as any).disableOnboarding = true;
    ensureConfigFile();
    redirectConsole();
    const cfg = getConfig();
    const host = opts.host || process.env.OPENCOMMANDER_HOST || cfg.http.host;
    const port = opts.port || Number(process.env.OPENCOMMANDER_PORT) || cfg.http.port;
    const adminPort = opts.adminPort || Number(process.env.OPENCOMMANDER_ADMIN_PORT) || cfg.http.admin_port;
    const token = getOrCreateToken();

    // Load the upstream core (tool handlers) lazily, after env/console setup.
    const baseHandlers = await loadCore();
    const makeServer = () => makeCoreServer(baseHandlers);

    const log = (msg: string) => { if (!opts.quiet) process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${msg}\n`); };

    const httpServer = http.createServer(async (req, res) => {
        cors(res);
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        if (url.pathname === '/healthz' || url.pathname === '/') {
            send(res, 200, { ok: true, name: 'opencommander', version: OC_VERSION, mcp: '/mcp' });
            return;
        }
        const m = /^\/mcp(?:\/([^/]+))?\/?$/.exec(url.pathname);
        if (!m) { send(res, 404, { error: 'not found' }); return; }

        // ---- auth: Bearer header, /mcp/<token>, or ?token=
        const auth = String(req.headers.authorization || '');
        const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : (m[1] || url.searchParams.get('token') || '');
        if (!presented || !safeEqual(presented, token)) {
            log(`401 ${req.method} ${url.pathname.replace(token, '***')} from ${req.socket.remoteAddress}`);
            send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
            return;
        }
        if (req.method === 'GET' || req.method === 'DELETE') {
            // Stateless server: no standalone SSE stream / session to delete.
            send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST)' }, id: null }, { Allow: 'POST, OPTIONS' });
            return;
        }
        if (req.method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return; }

        let body: unknown;
        try {
            const raw = await readBody(req);
            body = raw ? JSON.parse(raw) : undefined;
        } catch (e) {
            send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: `Parse error: ${(e as Error).message}` }, id: null });
            return;
        }
        const t0 = Date.now();
        const first = Array.isArray(body) ? body[0] : body;
        const label = first && typeof first === 'object' ? `${(first as any).method}${(first as any).params?.name ? ' ' + (first as any).params.name : ''}` : '?';
        const server = makeServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { transport.close().catch(() => undefined); server.close().catch(() => undefined); });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, body);
            log(`${res.statusCode} ${label} ${Date.now() - t0}ms`);
        } catch (e) {
            log(`500 ${label}: ${(e as Error).message}`);
            if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
        }
    });
    httpServer.keepAliveTimeout = 65000;
    httpServer.headersTimeout = 70000;
    httpServer.requestTimeout = 0; // tool calls manage their own time budget

    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => resolve());
    });

    let admin: http.Server | null = null;
    if (!opts.noAdmin) {
        admin = await startAdmin(adminPort);
        (global as any).__ocAdminPort = adminPort;
    }

    const banner = [
        '',
        `  OpenCommander ${OC_VERSION} — MCP over HTTP (stateless)`,
        `  MCP endpoint : http://${host}:${port}/mcp            (Authorization: Bearer <token>)`,
        `  Secret URL   : http://${host}:${port}/mcp/<token>    (for clients without header auth)`,
        `  Token        : ${token.slice(0, 4)}…  (full value: opencommander token)`,
        admin ? `  Approvals    : http://127.0.0.1:${adminPort}/   (local only, never tunnel this port)` : '  Approvals    : dashboard disabled (use: opencommander approve <id>)',
        `  State dir    : ${dirs.root}`,
        `  Profile      : ${cfg.security.profile}   allowed_roots: ${cfg.security.allowed_roots.join(', ') || 'any'}`,
        '',
        '  Expose it to ChatGPT with a tunnel, e.g.:  cloudflared tunnel --url http://127.0.0.1:' + port,
        '  then add a connector with URL  https://<tunnel-host>/mcp/<token>',
        '',
    ].join('\n');
    if (!opts.quiet) process.stderr.write(banner + '\n');

    const shutdown = () => {
        log('shutting down (background jobs keep running)');
        httpServer.close();
        admin?.close();
        setTimeout(() => process.exit(0), 300).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('uncaughtException', (e) => { try { fs.appendFileSync(path.join(dirs.root, 'server.log'), `${new Date().toISOString()} uncaught ${e.stack || e}\n`); } catch { /* ignore */ } log(`uncaught: ${e.message}`); });
    process.on('unhandledRejection', (e) => { log(`unhandled rejection: ${(e as Error)?.message || e}`); });
    return { httpServer, admin, port, adminPort, token };
}

// ------------------------------------------------------------------ admin dashboard (127.0.0.1 only)

const CSRF = crypto.randomBytes(18).toString('base64url');

function adminHtml(port: number): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenCommander</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--mut:#6b6b66;--card:#fff;--line:#e3e3de;--acc:#2f6f4f;--bad:#a8322d;--warn:#9a6a00}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecece8;--mut:#9a9a93;--card:#1f1f1d;--line:#33332f;--acc:#6cc497;--bad:#f07b73;--warn:#e0b04a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1000px;margin:0 auto;padding:20px 16px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 8px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:8px 0}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:220px}
code,pre{font:12.5px/1.4 ui-monospace,Consolas,monospace}pre{white-space:pre-wrap;word-break:break-all;margin:6px 0 0;background:var(--bg);padding:8px;border-radius:6px;max-height:220px;overflow:auto}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:6px 14px;border-radius:7px;cursor:pointer}
button.ok{background:var(--acc);border-color:var(--acc);color:#fff}button.no{color:var(--bad)}
.pill{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--mut)}
.pill.running{color:var(--acc);border-color:var(--acc)}.pill.failed,.pill.lost,.pill.timed_out{color:var(--bad);border-color:var(--bad)}
.mut{color:var(--mut)}table{width:100%;border-collapse:collapse}td{padding:5px 6px;border-top:1px solid var(--line);vertical-align:top}
.empty{color:var(--mut);padding:8px 2px}
</style></head><body><main>
<h1>OpenCommander</h1><div class="mut">Approvals &amp; jobs on this machine · port ${port} · auto-refresh</div>
<h2>Pending approvals</h2><div id="pending"></div>
<h2>Running jobs</h2><div id="jobs"></div>
<h2>Recent decisions</h2><div id="decided"></div>
<h2>Recent tool calls</h2><div id="audit"></div>
</main>
<script>
const CSRF=${JSON.stringify(CSRF)};
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function act(id,d){await fetch('/api/approvals/'+id+'/'+d,{method:'POST',headers:{'X-OC-CSRF':CSRF}});load();}
async function load(){
 let s;try{s=await (await fetch('/api/state',{headers:{'X-OC-CSRF':CSRF}})).json();}catch(e){return;}
 const p=document.getElementById('pending');
 p.innerHTML=s.pending.length?s.pending.map(a=>'<div class="card"><div class="row"><div class="grow"><b>'+esc(a.tool)+'</b> <span class="mut">'+esc(a.id)+' · '+esc(new Date(a.created_at).toLocaleTimeString())+'</span><div>'+a.reasons.map(r=>'<span class="pill">'+esc(r)+'</span>').join(' ')+'</div></div><button class="ok" onclick="act(\\''+a.id+'\\',\\'approve\\')">Approve</button><button class="no" onclick="act(\\''+a.id+'\\',\\'deny\\')">Deny</button></div><pre>'+esc(a.summary)+'</pre></div>').join(''):'<div class="empty">Nothing waiting.</div>';
 const j=document.getElementById('jobs');
 j.innerHTML=s.jobs.length?'<div class="card"><table>'+s.jobs.map(x=>'<tr><td><span class="pill '+esc(x.status)+'">'+esc(x.status)+'</span></td><td><code>'+esc(x.job_id)+'</code><div class="mut">'+esc(x.label||'')+' '+esc(x.stage||'')+'</div></td><td><code>'+esc(x.command||'(multi-step)')+'</code><div class="mut">'+esc(x.cwd)+'</div></td><td class="mut">'+esc(x.elapsed_seconds)+'s</td></tr>').join('')+'</table></div>':'<div class="empty">No running jobs.</div>';
 const d=document.getElementById('decided');
 d.innerHTML=s.decided.length?'<div class="card"><table>'+s.decided.map(a=>'<tr><td><span class="pill">'+esc(a.status)+'</span></td><td>'+esc(a.tool)+'</td><td><code>'+esc(a.summary.slice(0,160))+'</code></td></tr>').join('')+'</table></div>':'<div class="empty">—</div>';
 const au=document.getElementById('audit');
 au.innerHTML=s.audit.length?'<div class="card"><table>'+s.audit.map(e=>'<tr><td class="mut">'+esc(e.ts.slice(11,19))+'</td><td>'+esc(e.tool)+'</td><td><span class="pill">'+esc(e.decision)+'</span></td><td class="mut">'+esc(e.duration_ms??'')+(e.duration_ms!=null?'ms':'')+(e.is_error?' · error':'')+'</td></tr>').join('')+'</table></div>':'<div class="empty">—</div>';
}
load();setInterval(load,2500);
</script></body></html>`;
}

export async function startAdmin(port: number): Promise<http.Server> {
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    const srv = http.createServer(async (req, res) => {
        // DNS-rebinding / cross-site protection: only local Host, and CSRF token for API calls.
        if (!allowedHosts.has(String(req.headers.host || ''))) { send(res, 403, { error: 'forbidden host' }); return; }
        const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/approvals')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
            res.end(adminHtml(port));
            return;
        }
        if (!url.pathname.startsWith('/api/')) { send(res, 404, { error: 'not found' }); return; }
        if (req.headers['x-oc-csrf'] !== CSRF) { send(res, 403, { error: 'bad csrf token' }); return; }
        if (req.method === 'GET' && url.pathname === '/api/state') {
            const all = listApprovals('all', 40);
            send(res, 200, {
                pending: all.filter(a => a.status === 'pending'),
                decided: all.filter(a => a.status !== 'pending').slice(0, 15),
                jobs: listJobs({ status: 'active', limit: 30 }).map(summarize),
                audit: readAudit(25),
            });
            return;
        }
        const m = /^\/api\/approvals\/(apr_[a-z0-9]+)\/(approve|deny)$/i.exec(url.pathname);
        if (req.method === 'POST' && m) {
            try {
                const a = decide(m[1], m[2] === 'approve' ? 'approved' : 'denied', 'dashboard');
                process.stderr.write(`${new Date().toISOString().slice(11, 19)} approval ${a.id} ${a.status} (dashboard)\n`);
                send(res, 200, a);
            } catch (e) { send(res, 409, { error: (e as Error).message }); }
            return;
        }
        send(res, 404, { error: 'not found' });
    });
    await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, '127.0.0.1', () => resolve());
    });
    return srv;
}
