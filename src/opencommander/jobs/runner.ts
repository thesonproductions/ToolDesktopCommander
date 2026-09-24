#!/usr/bin/env node
/**
 * Detached job runner.
 *
 * Started by the JobManager as an independent, detached Node process:
 *     node runner.js <jobDir>
 *
 * It owns state.json for the job, runs each step through a shell with stdout
 * and stderr redirected *directly to output.log* (the child writes to the file
 * descriptor itself), writes a heartbeat, enforces timeout and handles cancel
 * requests. Because nothing here depends on the MCP server process, a job keeps
 * running when ChatGPT disconnects, the browser reloads, or the MCP server is
 * restarted.
 */
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { JobSpec, JobState, StepState } from './types.js';
import { IS_WIN, killTree, readJson, shellCommand, writeJsonAtomic } from '../util.js';

const jobDir = process.argv[2];
if (!jobDir) {
    process.stderr.write('usage: runner.js <jobDir>\n');
    process.exit(2);
}

const specFile = path.join(jobDir, 'spec.json');
const stateFile = path.join(jobDir, 'state.json');
const logFile = path.join(jobDir, 'output.log');
const cancelFile = path.join(jobDir, 'cancel');
const runnerLog = path.join(jobDir, 'runner.log');

function rlog(msg: string) {
    try { fs.appendFileSync(runnerLog, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
}

const spec = readJson<JobSpec>(specFile);
if (!spec) {
    rlog('spec.json missing or invalid');
    process.exit(2);
}

const now = () => new Date().toISOString();
const state: JobState = readJson<JobState>(stateFile) || { status: 'queued', steps: [] };
state.status = 'running';
state.runner_pid = process.pid;
state.started_at = state.started_at || now();
state.heartbeat_at = now();
state.steps = spec.steps.map((s): StepState => ({ name: s.name, command: s.command, status: 'pending' }));

function logSize(): number {
    try { return fs.statSync(logFile).size; } catch { return 0; }
}

function save() {
    state.heartbeat_at = now();
    state.log_bytes = logSize();
    try { writeJsonAtomic(stateFile, state); } catch (e) { rlog(`save failed: ${(e as Error).message}`); }
}

save();

let child: ChildProcess | null = null;
let cancelled = false;
let timedOut = false;
const startedMs = Date.now();

const heartbeat = setInterval(() => {
    if (!cancelled && fs.existsSync(cancelFile)) {
        cancelled = true;
        rlog('cancel requested');
        if (child?.pid) killChild(child.pid);
    }
    if (!timedOut && spec.timeout_seconds > 0 && Date.now() - startedMs > spec.timeout_seconds * 1000) {
        timedOut = true;
        rlog(`timeout after ${spec.timeout_seconds}s`);
        if (child?.pid) killChild(child.pid);
    }
    save();
}, 1000);

function killChild(pid: number) {
    killTree(pid, 'SIGTERM');
    if (!IS_WIN) {
        setTimeout(() => killTree(pid, 'SIGKILL'), 5000).unref();
    }
}

// The runner must never die with the terminal/MCP server that spawned it.
for (const sig of ['SIGHUP', 'SIGPIPE'] as NodeJS.Signals[]) {
    try { process.on(sig, () => rlog(`ignored ${sig}`)); } catch { /* unsupported on win */ }
}
for (const sig of ['SIGTERM', 'SIGINT'] as NodeJS.Signals[]) {
    try {
        process.on(sig, () => {
            rlog(`runner received ${sig}, cancelling job`);
            cancelled = true;
            if (child?.pid) killChild(child.pid);
        });
    } catch { /* ignore */ }
}

function appendMarker(text: string) {
    if (spec!.steps.length > 1) {
        try { fs.appendFileSync(logFile, text); } catch { /* ignore */ }
    }
}

function runStep(index: number): Promise<{ code: number | null; signal: string | null }> {
    const step = spec!.steps[index];
    const sh = shellCommand(step.command, spec!.shell);
    const fd = fs.openSync(logFile, 'a');
    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    delete baseEnv.NODE_TEST_CONTEXT;
    return new Promise((resolve) => {
        try {
            child = spawn(sh.file, sh.args, {
                cwd: spec!.cwd,
                env: {
                    ...baseEnv,
                    PYTHONUNBUFFERED: '1',
                    PYTHONIOENCODING: 'utf-8',
                    NO_COLOR: '1',
                    FORCE_COLOR: '0',
                    TERM: 'dumb',
                    GIT_TERMINAL_PROMPT: '0',
                    OPENCOMMANDER_JOB_ID: spec!.id,
                    OPENCOMMANDER_ARTIFACTS: path.join(jobDir, 'artifacts'),
                    ...(spec!.env || {}),
                },
                stdio: ['ignore', fd, fd],
                detached: !IS_WIN, // own process group on unix so we can kill the tree
                windowsHide: true,
                windowsVerbatimArguments: !!sh.verbatim,
            });
        } catch (e) {
            fs.closeSync(fd);
            fs.appendFileSync(logFile, `\n[opencommander] failed to start: ${(e as Error).message}\n`);
            resolve({ code: 127, signal: null });
            return;
        }
        state.pid = child.pid;
        save();
        let settled = false;
        child.on('error', (e) => {
            if (settled) return;
            settled = true;
            try { fs.closeSync(fd); } catch { /* ignore */ }
            fs.appendFileSync(logFile, `\n[opencommander] process error: ${e.message}\n`);
            resolve({ code: 127, signal: null });
        });
        child.on('exit', (code, signal) => {
            if (settled) return;
            settled = true;
            try { fs.closeSync(fd); } catch { /* ignore */ }
            resolve({ code, signal });
        });
    });
}

async function main() {
    let finalCode: number | null = 0;
    let anyFailed = false;
    for (let i = 0; i < spec!.steps.length; i++) {
        const st = state.steps[i];
        if (cancelled || timedOut || (anyFailed && !spec!.continue_on_failure)) {
            st.status = 'skipped';
            continue;
        }
        state.current_step = i;
        st.status = 'running';
        st.started_at = now();
        appendMarker(`\n===== [opencommander] step ${i + 1}/${spec!.steps.length}: ${st.name} =====\n$ ${st.command}\n`);
        st.log_start = logSize();
        save();
        const t0 = Date.now();
        const { code, signal } = await runStep(i);
        st.log_end = logSize();
        st.exit_code = code;
        st.signal = signal;
        st.finished_at = now();
        st.duration_ms = Date.now() - t0;
        if (cancelled) st.status = 'cancelled';
        else if (timedOut) st.status = 'timed_out';
        else if (code === 0) st.status = 'succeeded';
        else {
            st.status = 'failed';
            if (!spec!.steps[i].allow_failure) {
                anyFailed = true;
                finalCode = code ?? 1;
            }
        }
        appendMarker(`===== [opencommander] step ${st.name} -> ${st.status} (exit ${code ?? signal}, ${(st.duration_ms / 1000).toFixed(1)}s) =====\n`);
        state.pid = undefined;
        save();
    }
    clearInterval(heartbeat);
    state.status = cancelled ? 'cancelled' : timedOut ? 'timed_out' : anyFailed ? 'failed' : 'succeeded';
    state.exit_code = cancelled || timedOut ? null : anyFailed ? finalCode : 0;
    state.finished_at = now();
    state.current_step = undefined;
    save();
    rlog(`finished: ${state.status}`);
    process.exit(0);
}

main().catch((e) => {
    rlog(`fatal: ${(e as Error).stack || e}`);
    state.status = 'failed';
    state.error = String((e as Error).message || e);
    state.finished_at = now();
    save();
    process.exit(1);
});
