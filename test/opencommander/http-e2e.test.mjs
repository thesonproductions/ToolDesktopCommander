/**
 * End-to-end acceptance tests over the real HTTP MCP endpoint (what ChatGPT uses).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { call, freshHome, IS_WIN, makeRepo, rpc, sh, sleep, startServer, tmpdir } from './helpers.mjs';

const home = freshHome();
let srv;

test.before(async () => { srv = await startServer({ home }); });
test.after(async () => { await srv?.stop(); });

test('auth: 401 without/with wrong token; token in header or URL path works', async () => {
    const noAuth = await rpc(srv, 'tools/list', {}, { auth: false });
    assert.equal(noAuth.status, 401);
    const r = await fetch(`${srv.url}/${srv.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(r.status, 200);
    const wrong = await fetch(`${srv.url}/not-the-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(wrong.status, 401);
});

test('initialize returns instructions; tools/list has OpenCommander + core tools with annotations', async () => {
    const init = await rpc(srv, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1' } });
    assert.equal(init.json.result.serverInfo.name, 'opencommander');
    assert.match(init.json.result.instructions, /session_start/);
    const { json } = await rpc(srv, 'tools/list');
    const names = json.result.tools.map(t => t.name);
    for (const n of ['session_start', 'job_start', 'job_wait', 'repo_verify', 'git_checkpoint', 'repo_find_symbol', 'read_file', 'edit_block', 'start_process']) assert.ok(names.includes(n), n);
    assert.ok(!names.includes('give_feedback_to_desktop_commander'));
    const js = json.result.tools.find(t => t.name === 'job_status');
    assert.equal(js.annotations.readOnlyHint, true);
    const wf = json.result.tools.find(t => t.name === 'write_file');
    assert.ok(wf.inputSchema.properties.approval_id);
});

test('session_start orients the model', async () => {
    const { data } = await call(srv, 'session_start', {});
    assert.equal(data.server.name, 'OpenCommander');
    assert.match(data.workflow, /request_key/);
    assert.ok(Array.isArray(data.running_jobs));
});

test('ACCEPTANCE: job survives MCP server restart; duplicate retry does not spawn a second job', async () => {
    const cwd = tmpdir();
    const args = { command: sh.sleepEcho(4, 'long-job-finished'), cwd, request_key: 'accept-restart-1' };
    const first = await call(srv, 'job_start', args);
    const id = first.data.job_id;
    assert.match(id, /^job_/);

    // "ChatGPT timed out" -> retry with same key while server still up
    const retry = await call(srv, 'job_start', args);
    assert.equal(retry.data.job_id, id);
    assert.equal(retry.data.deduplicated, true);

    // Kill the MCP server entirely and start a new one (stateless: no session to lose)
    await srv.stop();
    srv = await startServer({ home });

    const again = await call(srv, 'job_start', args);
    assert.equal(again.data.job_id, id, 'retry after restart returns the same job');
    const w = await call(srv, 'job_wait', { job_id: id, timeout_seconds: 20 });
    assert.equal(w.data.status, 'succeeded');
    assert.match(w.data.new_output, /long-job-finished/);
});

test('test_run returns structured pytest failures', { skip: !hasPytest() && 'pytest not installed' }, async () => {
    const repo = await makeRepo({
        'calc.py': 'def add(a, b):\n    return a + b\n',
        'tests/test_calc.py': 'from calc import add\n\ndef test_ok():\n    assert add(1, 2) == 3\n\ndef test_bad():\n    assert add(2, 2) == 5, "broken math"\n',
        'conftest.py': '',
        'pyproject.toml': '[project]\nname="c"\n[tool.pytest.ini_options]\n',
    });
    const { data } = await call(srv, 'test_run', { path: repo, wait_seconds: 40 });
    assert.equal(data.finished, true);
    assert.equal(data.status, 'failed');
    assert.equal(data.tests.framework, 'pytest');
    assert.equal(data.tests.passed, 1);
    assert.equal(data.tests.failed, 1);
    assert.equal(data.tests.failures[0].file, 'tests/test_calc.py');
    assert.match(data.tests.failures[0].message, /broken math/);
});

test('repo_verify: node project with node:test, one call, overall + per-check', async () => {
    const repo = await makeRepo({
        'package.json': JSON.stringify({ name: 'v', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }),
        'lib.js': 'export const mul = (a, b) => a * b;\n',
        'test/lib.test.js': "import test from 'node:test';\nimport assert from 'node:assert';\nimport { mul } from '../lib.js';\ntest('mul', () => assert.strictEqual(mul(2, 3), 6));\n",
    });
    const { data } = await call(srv, 'repo_verify', { path: repo, wait_seconds: 50 });
    assert.equal(data.finished, true, JSON.stringify(data));
    assert.equal(data.overall, 'passed');
    const t = data.checks.find(c => c.name === 'test');
    assert.equal(t.tests.passed, 1);
    assert.ok(Array.isArray(data.summary));
});

test('slow work auto-backgrounds instead of timing out', async () => {
    const cwd = tmpdir();
    const { data } = await call(srv, 'test_run', { path: cwd, command: sh.sleepEcho(6, 'slow-done'), wait_seconds: 1 });
    assert.equal(data.finished, false);
    assert.match(data.next, /job_wait/);
    const w = await call(srv, 'job_wait', { job_id: data.job_id, timeout_seconds: 20 });
    assert.equal(w.data.status, 'succeeded');
    const r = await call(srv, 'job_result', { job_id: data.job_id });
    assert.equal(r.data.finished, true);
});

test('ACCEPTANCE: destructive op requires human approval (dashboard), approval is single-use', async () => {
    const cwd = tmpdir();
    fs.mkdirSync(path.join(cwd, 'build'));
    const args = { command: IS_WIN ? 'Remove-Item -Recurse -Force build' : 'rm -rf build', cwd };
    const first = await call(srv, 'job_start', args);
    assert.equal(first.data.status, 'APPROVAL_REQUIRED');
    const id = first.data.approval_id;

    const pending = await call(srv, 'job_start', { ...args, approval_id: id });
    assert.equal(pending.data.status, 'APPROVAL_PENDING');

    // Human approves on the local dashboard (needs CSRF token from the page + local Host)
    const page = await (await fetch(`http://127.0.0.1:${srv.adminPort}/`)).text();
    const csrf = /const CSRF="([^"]+)"/.exec(page)[1];
    const noCsrf = await fetch(`http://127.0.0.1:${srv.adminPort}/api/approvals/${id}/approve`, { method: 'POST' });
    assert.equal(noCsrf.status, 403);
    const ok = await fetch(`http://127.0.0.1:${srv.adminPort}/api/approvals/${id}/approve`, { method: 'POST', headers: { 'X-OC-CSRF': csrf } });
    assert.equal(ok.status, 200);

    const run = await call(srv, 'job_start', { ...args, approval_id: id, wait_seconds: 10 });
    assert.equal(run.data.status, 'succeeded');
    assert.ok(!fs.existsSync(path.join(cwd, 'build')));

    const reuse = await call(srv, 'job_start', { ...args, approval_id: id });
    assert.equal(reuse.data.status, 'APPROVAL_INVALID');
});

test('protected paths denied; catastrophic command denied', async () => {
    const r = await call(srv, 'read_file', { path: path.join(os.homedir(), '.ssh', 'id_rsa') });
    assert.equal(r.data.status, 'DENIED');
    const t = await call(srv, 'read_file', { path: path.join(home, 'token') });
    assert.equal(t.data.status, 'DENIED');
    const c = await call(srv, 'start_process', { command: 'rm -rf /', timeout_ms: 1000 });
    assert.equal(c.data.status, 'DENIED');
});

test('secrets in output are masked; masked content cannot be written back', async () => {
    const cwd = tmpdir();
    const secret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';
    fs.writeFileSync(path.join(cwd, '.env'), `OPENAI_API_KEY=${secret}\n`);
    const j = await call(srv, 'job_start', { command: IS_WIN ? 'Get-Content .env' : 'cat .env', cwd, wait_seconds: 10 });
    assert.ok(!JSON.stringify(j.raw).includes(secret));
    assert.match(j.texts.join('\n'), /MASKED/);
    const rf = await call(srv, 'read_file', { path: path.join(cwd, '.env') });
    assert.ok(!JSON.stringify(rf.raw).includes(secret));
    const w = await call(srv, 'write_file', { path: path.join(cwd, '.env'), content: 'OPENAI_API_KEY=[MASKED:openai_key]\n' });
    assert.equal(w.data.status, 'DENIED');
    assert.equal(fs.readFileSync(path.join(cwd, '.env'), 'utf8').includes(secret), true, 'real secret untouched');
});

test('checkpoint -> edit -> rollback through MCP', async () => {
    const repo = await makeRepo({ 'a.txt': 'original\n' });
    const cp = await call(srv, 'git_checkpoint', { path: repo, message: 'e2e' });
    await call(srv, 'write_file', { path: path.join(repo, 'a.txt'), content: 'changed\n', mode: 'rewrite' });
    await call(srv, 'write_file', { path: path.join(repo, 'b.txt'), content: 'new\n' });
    const st = await call(srv, 'repo_status', { path: repo });
    assert.equal(st.data.counts.unstaged, 1);
    assert.equal(st.data.counts.untracked, 1);
    const rb = await call(srv, 'git_rollback', { path: repo, checkpoint_id: cp.data.id });
    assert.equal(rb.isError, false, JSON.stringify(rb.data));
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'original\n');
    assert.ok(!fs.existsSync(path.join(repo, 'b.txt')));
});

test('task state survives restarts (resume after a chat timeout)', async () => {
    await call(srv, 'task_state_save', { task_id: 'Fix Reviewer', goal: 'fix schema', plan: ['a', 'b'], next_steps: ['b'], append_done: ['a'], progress_note: 'did a' });
    await srv.stop();
    srv = await startServer({ home });
    const { data } = await call(srv, 'task_state_get', { task_id: 'Fix Reviewer' });
    assert.equal(data.task_id, 'fix-reviewer');
    assert.deepEqual(data.done, ['a']);
    assert.deepEqual(data.next_steps, ['b']);
    const s = await call(srv, 'session_start', {});
    assert.ok(s.data.tasks.some(t => t.task_id === 'fix-reviewer'));
});

test('STRESS: 300 sequential tool calls without failure or leak', async () => {
    const cwd = tmpdir();
    fs.writeFileSync(path.join(cwd, 'x.txt'), 'hello\n');
    const t0 = Date.now();
    for (let i = 0; i < 300; i++) {
        const name = i % 3 === 0 ? 'job_list' : i % 3 === 1 ? 'read_ranges' : 'get_file_info';
        const args = name === 'job_list' ? { limit: 3 } : name === 'read_ranges' ? { items: [{ path: path.join(cwd, 'x.txt') }] } : { path: path.join(cwd, 'x.txt') };
        const r = await call(srv, name, args);
        assert.equal(r.isError, false, `${i} ${name}: ${r.texts[0]}`);
    }
    const perCall = (Date.now() - t0) / 300;
    assert.ok(perCall < 200, `avg ${perCall}ms per call`);
});

test('audit log records calls', async () => {
    const { data } = await call(srv, 'audit_log', { limit: 5 });
    assert.ok(data.entries.length >= 1);
    assert.ok(data.entries[0].ts);
});

function hasPytest() {
    const r = spawnSync(IS_WIN ? 'python' : 'python3', ['-m', 'pytest', '--version'], { encoding: 'utf8' });
    return r.status === 0;
}
