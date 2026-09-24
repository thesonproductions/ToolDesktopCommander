import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST = path.join(ROOT, 'dist');
export const CLI = path.join(DIST, 'opencommander', 'cli.js');
export const IS_WIN = process.platform === 'win32';

export function tmpdir(prefix = 'oc-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Fresh OPENCOMMANDER_HOME for this test process. */
export function freshHome() {
    const home = tmpdir('oc-home-');
    process.env.OPENCOMMANDER_HOME = home;
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
    return home;
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

export async function startServer({ home, token = 'test-token-abcdefghijklmnop', extraEnv = {} } = {}) {
    const port = await freePort();
    const adminPort = await freePort();
    const env = { ...process.env, OPENCOMMANDER_HOME: home, OPENCOMMANDER_TOKEN: token, DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1', ...extraEnv };
    delete env.NODE_TEST_CONTEXT; // don't leak node:test's IPC mode into jobs
    const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--admin-port', String(adminPort)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.stdout.on('data', d => { stderr += d.toString(); });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/healthz`);
            if (r.ok) break;
        } catch { /* not yet */ }
        await sleep(150);
    }
    return {
        child, port, adminPort, token,
        url: `http://127.0.0.1:${port}/mcp`,
        get log() { return stderr; },
        async stop() {
            if (child.exitCode !== null) return;
            child.kill('SIGTERM');
            await new Promise(r => child.once('exit', r));
        },
    };
}

let rpcId = 1;
/** Minimal MCP-over-HTTP JSON client (stateless server => no session handshake needed). */
export async function rpc(srv, method, params = {}, { auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (auth) headers.Authorization = `Bearer ${srv.token}`;
    const r = await fetch(srv.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, json };
}

export async function call(srv, name, args = {}) {
    const { status, json } = await rpc(srv, 'tools/call', { name, arguments: args });
    if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(json)}`);
    if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
    const res = json.result;
    const texts = (res.content || []).filter(c => c.type === 'text').map(c => c.text);
    let data = null;
    try { data = JSON.parse(texts[0]); } catch { data = texts[0]; }
    return { data, texts, isError: !!res.isError, raw: res };
}

export function git(cwd, ...args) {
    return new Promise((resolve, reject) => {
        const c = spawn('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
        let out = ''; let err = '';
        c.stdout.on('data', d => { out += d; });
        c.stderr.on('data', d => { err += d; });
        c.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`git ${args.join(' ')}: ${err}`))));
    });
}

export async function makeRepo(files) {
    const dir = tmpdir('oc-repo-');
    for (const [rel, content] of Object.entries(files)) {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
    }
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'init');
    return dir;
}

export function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Shell-appropriate commands for tests. */
export const sh = {
    sleepEcho: (secs, msg) => IS_WIN ? `Start-Sleep -Seconds ${secs}; Write-Output '${msg}'` : `sleep ${secs}; echo ${msg}`,
    echo: (msg) => IS_WIN ? `Write-Output '${msg}'` : `echo ${msg}`,
    fail: (code) => IS_WIN ? `exit ${code}` : `exit ${code}`,
};
