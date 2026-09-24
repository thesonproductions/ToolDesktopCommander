/**
 * `opencommander agent` — connects this computer OUT to the hub over a
 * WebSocket, so ChatGPT (via the hub's single MCP URL) can drive it without any
 * tunnel, open port or fixed IP here.
 *
 * The hub forwards three kinds of message; we answer each on the same socket:
 *   { type:'tools/list', id }                 -> this machine's tool schemas
 *   { type:'call', id, name, arguments }       -> run a tool (through the guard)
 *   { type:'approvals', id }                   -> list pending approvals
 *   { type:'decide', id, approval_id, decision } -> approve/deny remotely
 *
 * Tool calls run against the same in-process MCP core the HTTP server uses, so
 * the guard, secret masking, persistent jobs and every tool behave identically.
 */
import os from 'os';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ensureConfigFile, getConfig, machineName } from './config.js';
import { loadCore, makeCoreServer } from './core-bridge.js';
import { OC_VERSION } from './tools.js';
import { decide, listApprovals } from './security/approvals.js';

export interface AgentOptions { hubUrl?: string; agentKey?: string; name?: string; quiet?: boolean }

function wsUrl(base: string, name: string, key: string): string {
    const u = new URL(base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
    u.pathname = (u.pathname.replace(/\/+$/, '') || '') + '/agent';
    u.searchParams.set('name', name);
    u.searchParams.set('key', key);
    u.searchParams.set('hostname', os.hostname());
    u.searchParams.set('platform', `${process.platform}`);
    u.searchParams.set('version', OC_VERSION);
    return u.toString();
}

export async function runAgent(opts: AgentOptions = {}): Promise<void> {
    (global as any).__ocTransport = 'http'; // clamp long waits, background long work
    (global as any).disableOnboarding = true;
    ensureConfigFile();
    const cfg = getConfig();
    const hubUrl = opts.hubUrl || process.env.OPENCOMMANDER_HUB_URL || cfg.hub.url;
    const key = opts.agentKey || process.env.OPENCOMMANDER_AGENT_KEY || cfg.hub.agent_key;
    const name = (opts.name || machineName()).trim();
    if (!hubUrl) throw new Error('No hub URL. Set hub.url in config, pass --hub <url>, or OPENCOMMANDER_HUB_URL.');
    if (!key) throw new Error('No agent key. Set hub.agent_key, pass --key <AGENT_KEY>, or OPENCOMMANDER_AGENT_KEY.');

    const log = (m: string) => { if (!opts.quiet) process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`); };

    // In-process MCP core (same handlers/guard as the HTTP server).
    const handlers = await loadCore();
    const server = makeCoreServer(handlers);
    const client = new Client({ name: 'opencommander-agent', version: OC_VERSION });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    let toolsCache: unknown = null;
    const getTools = async () => {
        if (!toolsCache) toolsCache = (await client.listTools()).tools;
        return toolsCache;
    };

    let ws: WebSocket | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let stopped = false;
    let backoff = 1000;
    const target = wsUrl(hubUrl, name, key);

    const send = (obj: unknown) => { try { ws?.send(JSON.stringify(obj)); } catch { /* dropped; reconnect handles it */ } };

    async function handle(msg: any) {
        const id = msg?.id;
        try {
            if (msg.type === 'tools/list') {
                send({ type: 'result', id, result: { tools: await getTools() } });
            } else if (msg.type === 'call') {
                const result = await client.callTool({ name: msg.name, arguments: msg.arguments || {} });
                send({ type: 'result', id, result });
            } else if (msg.type === 'approvals') {
                const pending = listApprovals('pending', 50).map(x => ({ id: x.id, tool: x.tool, reasons: x.reasons, summary: x.summary, created_at: x.created_at }));
                send({ type: 'result', id, result: { pending } });
            } else if (msg.type === 'decide') {
                try {
                    const d = decide(msg.approval_id, msg.decision === 'approve' || msg.decision === 'approved' ? 'approved' : 'denied', 'hub');
                    send({ type: 'result', id, result: { id: d.id, status: d.status } });
                    log(`approval ${d.id} ${d.status} (via hub)`);
                } catch (e) {
                    send({ type: 'result', id, result: { error: (e as Error).message } });
                }
            }
        } catch (e) {
            send({ type: 'result', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: (e as Error).message }) }], isError: true } });
        }
    }

    function connect() {
        if (stopped) return;
        ws = new WebSocket(target, { handshakeTimeout: 15000 });
        ws.on('open', () => {
            backoff = 1000;
            log(`connected to hub as "${name}"  (${hubUrl})`);
            send({ type: 'hello', name });
            heartbeat = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) { send({ type: 'heartbeat', name }); try { ws.ping(); } catch { /* ignore */ } } }, 25000);
        });
        ws.on('message', (data: WebSocket.RawData) => {
            let msg: any;
            try { msg = JSON.parse(data.toString()); } catch { return; }
            if (msg && msg.type) void handle(msg);
        });
        const reconnect = (why: string) => {
            if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
            ws = null;
            if (stopped) return;
            const wait = Math.min(backoff, 30000) + Math.floor(Math.random() * 500);
            log(`disconnected (${why}); reconnecting in ${Math.round(wait / 1000)}s`);
            backoff = Math.min(backoff * 2, 30000);
            setTimeout(connect, wait);
        };
        ws.on('close', (code: number) => reconnect(`close ${code}`));
        ws.on('error', (e: Error) => { log(`ws error: ${e.message}`); try { ws?.close(); } catch { /* ignore */ } });
    }

    if (!opts.quiet) {
        process.stderr.write([
            '',
            `  OpenCommander agent ${OC_VERSION}`,
            `  Machine : ${name}   (${os.hostname()}, ${process.platform})`,
            `  Hub     : ${hubUrl}`,
            `  Profile : ${cfg.security.profile}   allowed_roots: ${cfg.security.allowed_roots.join(', ') || 'any'}`,
            '  Approvals: this machine\'s dashboard, or the hub dashboard <hub>/admin',
            '  (background jobs keep running even if this agent restarts)',
            '',
        ].join('\n') + '\n');
    }
    connect();

    const shutdown = () => { stopped = true; if (heartbeat) clearInterval(heartbeat); try { ws?.close(); } catch { /* ignore */ } log('agent stopped (jobs keep running)'); setTimeout(() => process.exit(0), 200).unref(); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    // keep process alive
    await new Promise<void>(() => { /* runs until killed */ });
}
