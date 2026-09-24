/**
 * Hub <-> agent protocol test.
 *
 * Stands up a minimal Node WebSocket "hub" that speaks the same wire protocol as
 * the Cloudflare Worker, launches a REAL `opencommander agent` child process,
 * and drives it: registration, tools/list, a real tool call, remote approval,
 * and reconnect after the socket drops.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import { CLI, freshHome, sleep, tmpdir } from './helpers.mjs';

const AGENT_KEY = 'test-agent-key';

/** Minimal hub: accepts one agent, exposes helpers to call it. */
function makeHub() {
    const wss = new WebSocketServer({ port: 0 });
    const state = { socket: null, name: null, meta: null, pending: new Map(), connects: 0 };
    wss.on('connection', (ws, req) => {
        const url = new URL(req.url, 'http://x');
        if (url.searchParams.get('key') !== AGENT_KEY) { ws.close(); return; }
        state.socket = ws;
        state.name = url.searchParams.get('name');
        state.meta = { hostname: url.searchParams.get('hostname'), platform: url.searchParams.get('platform'), version: url.searchParams.get('version') };
        state.connects++;
        ws.on('message', (d) => {
            let m; try { m = JSON.parse(d.toString()); } catch { return; }
            if (m.type === 'result' && m.id && state.pending.has(m.id)) {
                const { resolve, timer } = state.pending.get(m.id);
                clearTimeout(timer); state.pending.delete(m.id); resolve(m);
            }
        });
        ws.on('close', () => { if (state.socket === ws) state.socket = null; });
    });
    const port = () => wss.address().port;
    const rpc = (payload, timeoutMs = 8000) => new Promise((resolve, reject) => {
        if (!state.socket) return reject(new Error('no agent connected'));
        const id = Math.random().toString(36).slice(2);
        const timer = setTimeout(() => { state.pending.delete(id); reject(new Error('rpc timeout')); }, timeoutMs);
        state.pending.set(id, { resolve, timer });
        state.socket.send(JSON.stringify({ ...payload, id }));
    });
    return { wss, state, port, rpc, close: () => wss.close() };
}

async function waitFor(fn, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await sleep(100); }
    return false;
}

test('agent registers, runs tools, honours remote approvals, and reconnects', async (t) => {
    const home = freshHome();
    const hub = makeHub();
    const cwd = tmpdir();
    const env = { ...process.env, OPENCOMMANDER_HOME: home, OPENCOMMANDER_AGENT_KEY: AGENT_KEY, OPENCOMMANDER_HUB_URL: `http://127.0.0.1:${hub.port()}`, OPENCOMMANDER_MACHINE: 'TestPC' };
    delete env.NODE_TEST_CONTEXT;
    const agent = spawn(process.execPath, [CLI, 'agent'], { env, stdio: 'ignore' });
    t.after(() => { try { agent.kill('SIGKILL'); } catch { /* */ } hub.close(); });

    assert.ok(await waitFor(() => hub.state.socket && hub.state.name === 'TestPC'), 'agent connected');
    assert.equal(hub.state.meta.version.includes('-oc'), true);

    // tools/list
    const tl = await hub.rpc({ type: 'tools/list' });
    const names = tl.result.tools.map(x => x.name);
    assert.ok(names.includes('session_start') && names.includes('job_start') && names.includes('git_checkpoint'));

    // real tool call executes on this machine
    const call = await hub.rpc({ type: 'call', name: 'job_start', arguments: { command: process.platform === 'win32' ? 'Write-Output hub-ok' : 'echo hub-ok', cwd, wait_seconds: 8 } }, 20000);
    const data = JSON.parse(call.result.content[0].text);
    assert.equal(data.status, 'succeeded');
    assert.match(data.new_output, /hub-ok/);

    // session_start reports the machine name
    const ss = await hub.rpc({ type: 'call', name: 'session_start', arguments: {} }, 12000);
    assert.equal(JSON.parse(ss.result.content[0].text).server.machine, 'TestPC');

    // risky command -> APPROVAL_REQUIRED, then approve remotely via the hub protocol
    fs.mkdirSync(path.join(cwd, 'build'), { recursive: true });
    const risky = { name: 'job_start', arguments: { command: process.platform === 'win32' ? 'Remove-Item -Recurse -Force build' : 'rm -rf build', cwd } };
    const req = await hub.rpc({ type: 'call', ...risky }, 12000);
    const aprId = JSON.parse(req.result.content[0].text).approval_id;
    assert.match(aprId, /^apr_/);

    const list = await hub.rpc({ type: 'approvals' });
    assert.ok(list.result.pending.some(a => a.id === aprId));
    const dec = await hub.rpc({ type: 'decide', approval_id: aprId, decision: 'approve' });
    assert.equal(dec.result.status, 'approved');

    const run = await hub.rpc({ type: 'call', name: 'job_start', arguments: { ...risky.arguments, approval_id: aprId, wait_seconds: 8 } }, 20000);
    assert.equal(JSON.parse(run.result.content[0].text).status, 'succeeded');
    assert.ok(!fs.existsSync(path.join(cwd, 'build')));

    // reconnect: drop the socket, agent should dial back on its own
    const before = hub.state.connects;
    hub.state.socket.close();
    assert.ok(await waitFor(() => hub.state.connects > before && hub.state.socket, 15000), 'agent reconnected');
    const after = await hub.rpc({ type: 'call', name: 'job_start', arguments: { command: process.platform === 'win32' ? 'Write-Output back' : 'echo back', cwd, wait_seconds: 8 } }, 20000);
    assert.equal(JSON.parse(after.result.content[0].text).status, 'succeeded');
});

test('agent rejects a wrong agent key', async (t) => {
    const home = freshHome();
    const hub = makeHub();
    const env = { ...process.env, OPENCOMMANDER_HOME: home, OPENCOMMANDER_AGENT_KEY: 'WRONG', OPENCOMMANDER_HUB_URL: `http://127.0.0.1:${hub.port()}`, OPENCOMMANDER_MACHINE: 'Nope' };
    delete env.NODE_TEST_CONTEXT;
    const agent = spawn(process.execPath, [CLI, 'agent'], { env, stdio: 'ignore' });
    t.after(() => { try { agent.kill('SIGKILL'); } catch { /* */ } hub.close(); });
    const connected = await waitFor(() => !!hub.state.socket, 4000);
    assert.equal(connected, false, 'hub must not accept an agent with the wrong key');
});
