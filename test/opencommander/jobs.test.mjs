import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { DIST, freshHome, IS_WIN, isAlive, sh, sleep, tmpdir } from './helpers.mjs';

const home = freshHome();
const M = await import(path.join(DIST, 'opencommander', 'jobs', 'manager.js'));
const cwd = tmpdir('oc-cwd-');

async function waitDone(id, secs = 30) {
    return M.waitJob(id, secs);
}

test('job runs in background, returns immediately, captures output + exit code', async () => {
    const t0 = Date.now();
    const { job } = M.startJob({ command: sh.sleepEcho(1, 'hello-job'), cwd });
    assert.ok(Date.now() - t0 < 1500, 'start returns immediately');
    const w = await waitDone(job.spec.id);
    assert.equal(w.status, 'succeeded');
    assert.equal(w.exit_code, 0);
    assert.match(w.new_output, /hello-job/);
});

test('failing command -> failed with exit code', async () => {
    const { job } = M.startJob({ command: IS_WIN ? 'Write-Output boom; exit 3' : 'echo boom; exit 3', cwd });
    const w = await waitDone(job.spec.id);
    assert.equal(w.status, 'failed');
    assert.equal(w.exit_code, 3);
});

test('request_key idempotency: same key returns same job; different command conflicts', async () => {
    const a = M.startJob({ command: sh.sleepEcho(1, 'once'), cwd, request_key: 'k-1' });
    const b = M.startJob({ command: sh.sleepEcho(1, 'once'), cwd, request_key: 'k-1' });
    assert.equal(b.job.spec.id, a.job.spec.id);
    assert.equal(b.deduplicated, true);
    await waitDone(a.job.spec.id);
    const c = M.startJob({ command: sh.sleepEcho(1, 'once'), cwd, request_key: 'k-1' });
    assert.equal(c.job.spec.id, a.job.spec.id, 'still deduped after completion (no re-run)');
    assert.throws(() => M.startJob({ command: sh.echo('different'), cwd, request_key: 'k-1' }), /already used for a different command/);
});

test('concurrent callers with the same request_key spawn exactly one job', async () => {
    const script = `
      process.env.OPENCOMMANDER_HOME = ${JSON.stringify(home)};
      const M = await import(${JSON.stringify('file://' + path.join(DIST, 'opencommander', 'jobs', 'manager.js').replace(/\\/g, '/'))});
      const r = M.startJob({ command: ${JSON.stringify(sh.sleepEcho(1, 'race'))}, cwd: ${JSON.stringify(cwd)}, request_key: 'race-key' });
      process.stdout.write(r.job.spec.id);
    `;
    const procs = Array.from({ length: 6 }, () => new Promise((resolve) => {
        const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, OPENCOMMANDER_HOME: home } });
        let out = '';
        c.stdout.on('data', d => { out += d; });
        c.on('close', () => resolve(out.trim()));
    }));
    const ids = await Promise.all(procs);
    assert.equal(new Set(ids).size, 1, `ids: ${ids.join(',')}`);
    const jobs = M.listJobs({ limit: 200 }).filter(j => j.spec.request_key === 'race-key');
    assert.equal(jobs.length, 1);
});

test('auto-dedupe of an identical retried call without request_key', async () => {
    const a = M.startJob({ command: sh.sleepEcho(2, 'retry'), cwd });
    const b = M.startJob({ command: sh.sleepEcho(2, 'retry'), cwd });
    assert.equal(b.job.spec.id, a.job.spec.id);
    assert.equal(b.deduplicated, true);
    await waitDone(a.job.spec.id);
});

test('job survives death of the process that started it (MCP server restart)', async () => {
    const script = `
      const M = await import(${JSON.stringify('file://' + path.join(DIST, 'opencommander', 'jobs', 'manager.js').replace(/\\/g, '/'))});
      const r = M.startJob({ command: ${JSON.stringify(sh.sleepEcho(3, 'survived'))}, cwd: ${JSON.stringify(cwd)} });
      process.stdout.write(r.job.spec.id);
      process.exit(0);
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, OPENCOMMANDER_HOME: home }, encoding: 'utf8' });
    const id = r.stdout.trim();
    assert.match(id, /^job_/);
    const mid = M.requireJob(id);
    assert.ok(['queued', 'running'].includes(mid.state.status), mid.state.status);
    const w = await waitDone(id, 20);
    assert.equal(w.status, 'succeeded');
    assert.match(w.new_output, /survived/);
});

test('cancel kills the whole process tree', { skip: IS_WIN && 'posix tree check' }, async () => {
    const { job } = M.startJob({ command: 'sleep 100 & sleep 100 & echo started; wait', cwd });
    await M.waitJob(job.spec.id, 5, 0, 'started');
    const pid = M.requireJob(job.spec.id).state.pid;
    assert.ok(pid && isAlive(pid));
    const r = await M.cancelJob(job.spec.id);
    assert.equal(r.status, 'cancelled');
    await sleep(500);
    const ps = spawnSync('ps', ['-eo', 'pid,pgid,cmd'], { encoding: 'utf8' }).stdout;
    const leftovers = ps.split('\n').filter(l => l.trim().split(/\s+/)[1] === String(pid) && !l.includes('<defunct>'));
    assert.equal(leftovers.length, 0, leftovers.join('\n'));
});

test('timeout_seconds kills and marks timed_out', async () => {
    const { job } = M.startJob({ command: sh.sleepEcho(30, 'never'), cwd, timeout_seconds: 1 });
    const w = await waitDone(job.spec.id, 15);
    assert.equal(w.status, 'timed_out');
});

test('runner killed (reboot/crash) -> job reported as lost', async () => {
    const { job } = M.startJob({ command: sh.sleepEcho(60, 'x'), cwd });
    await M.waitJob(job.spec.id, 3, 0, 'NEVER_MATCHES_ANYTHING');
    const st = M.requireJob(job.spec.id).state;
    process.kill(st.runner_pid, 'SIGKILL');
    if (st.pid) { try { process.kill(IS_WIN ? st.pid : -st.pid, 'SIGKILL'); } catch { /* */ } }
    await sleep(6500);
    const j = M.requireJob(job.spec.id);
    assert.equal(j.state.status, 'lost');
});

test('huge output never floods: tail, paging and grep are bounded', async () => {
    const cmd = IS_WIN
        ? '1..200000 | ForEach-Object { "line $_ some padding text to make it longer xxxxxxxxxxxx" }; Write-Output "NEEDLE-END"'
        : 'for i in $(seq 1 200000); do echo "line $i some padding text to make it longer xxxxxxxxxxxx"; done; echo NEEDLE-END';
    const { job } = M.startJob({ command: cmd, cwd });
    const w = await waitDone(job.spec.id, 60);
    assert.equal(w.status, 'succeeded');
    assert.ok(w.log_bytes > 10_000_000, `log ${w.log_bytes}`);
    assert.ok(w.new_output.length < 7000, 'wait output bounded');
    const j = M.requireJob(job.spec.id);
    const tail = await M.readLogs(j, { tail_lines: 50 });
    assert.ok(tail.text.length < 12001);
    assert.match(tail.text, /NEEDLE-END/);
    const page = await M.readLogs(j, { offset: 0, max_bytes: 5000 });
    assert.ok(page.text.length <= 5000);
    assert.ok(page.next_offset > 0 && page.next_offset <= 5000);
    assert.match(page.text, /^line 1 /);
    const g = await M.readLogs(j, { grep: 'line 123456 ', context: 1 });
    assert.equal(g.total_matches, 1);
    assert.match(g.lines, /123455/);
});

test('multi-step job with continue_on_failure records per-step status and log ranges', async () => {
    const { job } = M.startJob({
        cwd, continue_on_failure: true,
        steps: [
            { name: 'one', command: sh.echo('step-one') },
            { name: 'two', command: IS_WIN ? 'Write-Output step-two; exit 2' : 'echo step-two; exit 2' },
            { name: 'three', command: sh.echo('step-three') },
        ],
    });
    const w = await waitDone(job.spec.id);
    assert.equal(w.status, 'failed');
    assert.deepEqual(w.steps.map(s => s.status), ['succeeded', 'failed', 'succeeded']);
    const two = await M.readLogs(M.requireJob(job.spec.id), { step: 'two' });
    assert.match(two.text, /step-two/);
    assert.doesNotMatch(two.text, /step-three/);
});

test('job_wait until_pattern returns early (server readiness)', async () => {
    const cmd = IS_WIN ? "Write-Output 'Listening on 8080'; Start-Sleep -Seconds 20" : 'echo "Listening on 8080"; sleep 20';
    const { job } = M.startJob({ command: cmd, cwd });
    const t0 = Date.now();
    const w = await M.waitJob(job.spec.id, 15, 0, 'Listening on \\d+');
    assert.equal(w.pattern_matched, true);
    assert.ok(Date.now() - t0 < 8000);
    await M.cancelJob(job.spec.id);
});

test('cleanup removes old finished jobs', async () => {
    const before = M.listJobs({ status: 'finished', limit: 500 }).length;
    const r = M.cleanupJobs(0);
    assert.ok(r.removed.length >= 1 && r.removed.length <= before);
    assert.ok(fs.existsSync(path.join(home, 'jobs')));
});
