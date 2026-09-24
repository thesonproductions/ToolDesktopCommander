/**
 * Persistent Job Manager.
 *
 * Jobs are plain directories on disk — no database, no native modules — so the
 * registry survives MCP restarts, crashes and reboots and works identically on
 * Windows, macOS and Linux:
 *
 *   ~/.opencommander/jobs/<job_id>/
 *       spec.json     immutable description (written once by the server)
 *       state.json    live state (owned by the detached runner)
 *       output.log    combined stdout+stderr (written by the child directly)
 *       cancel        flag file: presence asks the runner to stop
 *       artifacts/    free-form outputs ($OPENCOMMANDER_ARTIFACTS)
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirs, ensureDirs, getConfig } from '../config.js';
import { JobSpec, JobState, JobStep, TERMINAL_STATUSES } from './types.js';
import {
    fileSize, isPidAlive, killTree, newId, readJson, readRange, sleep, stripAnsi,
    tailFile, ToolError, writeJsonAtomic,
} from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, 'runner.js');

export interface Job { spec: JobSpec; state: JobState; dir: string }

export interface StartJobOptions {
    command?: string;
    steps?: JobStep[];
    cwd: string;
    shell?: string;
    env?: Record<string, string>;
    timeout_seconds?: number;
    request_key?: string;
    label?: string;
    kind?: string;
    continue_on_failure?: boolean;
    metadata?: Record<string, unknown>;
}

export interface StartJobResult { job: Job; deduplicated: boolean; dedupe_reason?: string }

function jobDir(id: string): string {
    if (!/^job_[a-z0-9]+$/i.test(id)) throw new ToolError(`Invalid job id: ${id}`);
    return path.join(dirs.jobs, id);
}

function keyFile(requestKey: string): string {
    const h = crypto.createHash('sha256').update(requestKey).digest('hex').slice(0, 40);
    return path.join(dirs.keys, `${h}.json`);
}

function signature(cwd: string, steps: JobStep[]): string {
    return crypto.createHash('sha256')
        .update(path.resolve(cwd).toLowerCase() + '\0' + steps.map(s => s.command).join('\0'))
        .digest('hex');
}

export function loadJob(id: string): Job | null {
    const dir = jobDir(id);
    const spec = readJson<JobSpec>(path.join(dir, 'spec.json'));
    if (!spec) return null;
    const state = readJson<JobState>(path.join(dir, 'state.json')) || { status: 'queued', steps: [] };
    const job = { spec, state, dir };
    reconcile(job);
    return job;
}

export function requireJob(id: string): Job {
    const j = loadJob(id);
    if (!j) throw new ToolError(`Job not found: ${id}`, { hint: 'Use job_list to see known jobs.' });
    return j;
}

/** Detect runners that died (reboot, kill) and mark their jobs as lost. */
function reconcile(job: Job): void {
    const st = job.state;
    if (TERMINAL_STATUSES.includes(st.status)) return;
    const hbAge = st.heartbeat_at ? Date.now() - Date.parse(st.heartbeat_at) : Infinity;
    const createdAge = Date.now() - Date.parse(job.spec.created_at);
    const runnerAlive = isPidAlive(st.runner_pid);
    if (runnerAlive) return;
    if (st.status === 'queued' && createdAge < 15000) return; // runner still booting
    if (st.status === 'running' && hbAge < 5000) return;      // state just written
    // Re-read once: the runner may have finished between our reads.
    const fresh = readJson<JobState>(path.join(job.dir, 'state.json'));
    if (fresh && TERMINAL_STATUSES.includes(fresh.status)) { job.state = fresh; return; }
    st.status = 'lost';
    st.error = 'Runner process is gone (machine restart, sleep kill, or manual kill). ' +
        (isPidAlive(st.pid) ? `Child pid ${st.pid} may still be alive.` : 'No child process alive.');
    st.finished_at = new Date().toISOString();
    try { writeJsonAtomic(path.join(job.dir, 'state.json'), st); } catch { /* ignore */ }
}

function listJobIds(): string[] {
    try {
        return fs.readdirSync(dirs.jobs).filter(n => n.startsWith('job_')).sort();
    } catch { return []; }
}

export function listJobs(filter: { status?: string; limit?: number; cwd?: string; kind?: string } = {}): Job[] {
    const ids = listJobIds().reverse();
    const out: Job[] = [];
    for (const id of ids) {
        const j = loadJob(id);
        if (!j) continue;
        if (filter.status) {
            const want = filter.status;
            const active = !TERMINAL_STATUSES.includes(j.state.status);
            if (want === 'active' ? !active : want === 'finished' ? active : j.state.status !== want) continue;
        }
        if (filter.kind && j.spec.kind !== filter.kind) continue;
        if (filter.cwd && path.resolve(j.spec.cwd).toLowerCase() !== path.resolve(filter.cwd).toLowerCase()) continue;
        out.push(j);
        if (out.length >= (filter.limit ?? 20)) break;
    }
    return out;
}

function findRecentDuplicate(sig: string, windowSec: number): Job | null {
    if (windowSec <= 0) return null;
    const ids = listJobIds().slice(-40).reverse();
    for (const id of ids) {
        const j = loadJob(id);
        if (!j) continue;
        const age = (Date.now() - Date.parse(j.spec.created_at)) / 1000;
        if (age > windowSec) break;
        if (j.spec.metadata?.signature === sig && !TERMINAL_STATUSES.includes(j.state.status)) return j;
    }
    return null;
}

export function startJob(opts: StartJobOptions): StartJobResult {
    ensureDirs();
    const cfg = getConfig();
    const steps: JobStep[] = opts.steps && opts.steps.length
        ? opts.steps
        : opts.command ? [{ name: opts.label || 'command', command: opts.command }] : [];
    if (!steps.length) throw new ToolError('Provide `command` or `steps`.');
    if (!opts.cwd || !fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) {
        throw new ToolError(`cwd does not exist or is not a directory: ${opts.cwd}`);
    }
    const cwd = path.resolve(opts.cwd);
    const sig = signature(cwd, steps);

    // 1) Idempotency by explicit request_key.
    let keyPath: string | null = null;
    if (opts.request_key) {
        keyPath = keyFile(opts.request_key);
        const existing = readJson<{ job_id: string; signature: string }>(keyPath);
        if (existing?.job_id) {
            const j = loadJob(existing.job_id);
            if (j) {
                if (existing.signature && existing.signature !== sig) {
                    throw new ToolError(
                        `request_key "${opts.request_key}" was already used for a different command (job ${existing.job_id}).`,
                        { existing_job_id: existing.job_id, hint: 'Use a new request_key for a different command.' });
                }
                return { job: j, deduplicated: true, dedupe_reason: 'request_key already used — returning the existing job instead of starting a duplicate' };
            }
        }
    }

    // 2) Implicit dedupe of retried calls (same command + cwd, still running, very recent).
    if (!opts.request_key) {
        const dup = findRecentDuplicate(sig, cfg.jobs.auto_dedupe_seconds);
        if (dup) {
            return { job: dup, deduplicated: true, dedupe_reason: `identical command started ${Math.round((Date.now() - Date.parse(dup.spec.created_at)) / 1000)}s ago and is still running (likely a retried call). Pass a request_key to force a separate run.` };
        }
    }

    const id = newId('job');
    const dir = path.join(dirs.jobs, id);
    fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });

    // Claim the key atomically (a racing duplicate call loses here).
    if (keyPath) {
        try {
            const fd = fs.openSync(keyPath, 'wx');
            fs.writeSync(fd, JSON.stringify({ job_id: id, signature: sig, request_key: opts.request_key, created_at: new Date().toISOString() }));
            fs.closeSync(fd);
        } catch (e: any) {
            if (e?.code === 'EEXIST') {
                fs.rmSync(dir, { recursive: true, force: true });
                for (let i = 0; i < 20; i++) {
                    const existing = readJson<{ job_id: string }>(keyPath);
                    const j = existing?.job_id ? loadJob(existing.job_id) : null;
                    if (j) return { job: j, deduplicated: true, dedupe_reason: 'concurrent call with the same request_key' };
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
                }
                throw new ToolError('request_key is being claimed by a concurrent call; retry job_list.');
            }
            throw e;
        }
    }

    const spec: JobSpec = {
        id,
        created_at: new Date().toISOString(),
        label: opts.label,
        cwd,
        shell: opts.shell || cfg.jobs.shell,
        env: opts.env,
        steps,
        timeout_seconds: Math.max(0, Math.floor(opts.timeout_seconds ?? 0)),
        request_key: opts.request_key,
        continue_on_failure: !!opts.continue_on_failure,
        kind: opts.kind || 'shell',
        metadata: { ...(opts.metadata || {}), signature: sig },
    };
    writeJsonAtomic(path.join(dir, 'spec.json'), spec);
    const state: JobState = { status: 'queued', steps: [] };
    writeJsonAtomic(path.join(dir, 'state.json'), state);
    fs.writeFileSync(path.join(dir, 'output.log'), '');

    const child = spawn(process.execPath, [RUNNER, dir], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd,
        env: process.env,
    });
    child.on('error', (e) => {
        const s = readJson<JobState>(path.join(dir, 'state.json')) || state;
        s.status = 'failed';
        s.error = `Failed to start runner: ${e.message}`;
        s.finished_at = new Date().toISOString();
        try { writeJsonAtomic(path.join(dir, 'state.json'), s); } catch { /* ignore */ }
    });
    child.unref();
    state.runner_pid = child.pid;
    // Runner may already have overwritten state.json; only fill runner_pid if still queued.
    const cur = readJson<JobState>(path.join(dir, 'state.json'));
    if (cur && cur.status === 'queued') {
        cur.runner_pid = child.pid;
        try { writeJsonAtomic(path.join(dir, 'state.json'), cur); } catch { /* ignore */ }
    }
    return { job: { spec, state: cur || state, dir }, deduplicated: false };
}

export function isTerminal(job: Job): boolean {
    return TERMINAL_STATUSES.includes(job.state.status);
}

export function logPath(job: Job): string {
    return path.join(job.dir, 'output.log');
}

export function summarize(job: Job): Record<string, any> {
    const st = job.state;
    const created = Date.parse(job.spec.created_at);
    const started = st.started_at ? Date.parse(st.started_at) : created;
    const end = st.finished_at ? Date.parse(st.finished_at) : Date.now();
    const multi = job.spec.steps.length > 1;
    const out: Record<string, unknown> = {
        job_id: job.spec.id,
        status: st.status,
        kind: job.spec.kind,
        label: job.spec.label,
        cwd: job.spec.cwd,
        command: multi ? undefined : job.spec.steps[0]?.command,
        exit_code: st.exit_code,
        elapsed_seconds: Math.round((end - started) / 100) / 10,
        created_at: job.spec.created_at,
        finished_at: st.finished_at,
        request_key: job.spec.request_key,
        log_bytes: fileSize(logPath(job)),
    };
    if (!isTerminal(job)) {
        out.pid = st.pid;
        out.heartbeat_age_seconds = st.heartbeat_at ? Math.round((Date.now() - Date.parse(st.heartbeat_at)) / 100) / 10 : null;
        if (st.current_step !== undefined && job.spec.steps[st.current_step]) out.stage = job.spec.steps[st.current_step].name;
    }
    if (multi) {
        out.steps = (st.steps.length ? st.steps : job.spec.steps.map(s => ({ name: s.name, command: s.command, status: 'pending' as const })))
            .map(s => ({ name: s.name, status: s.status, exit_code: (s as any).exit_code, seconds: (s as any).duration_ms !== undefined ? Math.round((s as any).duration_ms / 100) / 10 : undefined }));
    }
    if (st.error) out.error = st.error;
    return out;
}

export interface ReadLogsOptions {
    offset?: number;
    max_bytes?: number;
    tail_lines?: number;
    grep?: string;
    context?: number;
    max_matches?: number;
    step?: string | number;
}

function stepRange(job: Job, step: string | number | undefined): { start: number; end: number } | null {
    if (step === undefined || step === null || step === '') return null;
    const steps = job.state.steps || [];
    const idx = typeof step === 'number' ? step : steps.findIndex(s => s.name === step);
    const s = steps[idx];
    if (!s || s.log_start === undefined) return null;
    return { start: s.log_start, end: s.log_end ?? fileSize(logPath(job)) };
}

export async function readLogs(job: Job, o: ReadLogsOptions) {
    const file = logPath(job);
    const size = fileSize(file);
    const maxBytes = Math.min(Math.max(o.max_bytes ?? 12000, 500), 100000);
    const range = stepRange(job, o.step);

    if (o.grep) {
        let re: RegExp;
        try { re = new RegExp(o.grep, 'i'); } catch { re = new RegExp(o.grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
        const ctx = Math.min(Math.max(o.context ?? 2, 0), 20);
        const maxMatches = Math.min(Math.max(o.max_matches ?? 40, 1), 400);
        const matches: Array<{ line: number; text: string }> = [];
        let total = 0;
        const before: Array<{ n: number; t: string }> = [];
        let afterLeft = 0;
        let n = 0;
        const stream = fs.createReadStream(file, {
            encoding: 'utf8',
            start: range?.start ?? 0,
            end: range ? Math.max(range.start, range.end - 1) : undefined,
        });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let budget = maxBytes;
        for await (const raw of rl) {
            n++;
            const line = stripAnsi(raw);
            if (re.test(line)) {
                total++;
                if (matches.length < maxMatches && budget > 0) {
                    for (const b of before) { matches.push({ line: b.n, text: b.t }); budget -= b.t.length; }
                    before.length = 0;
                    matches.push({ line: n, text: `>> ${line}` });
                    budget -= line.length;
                    afterLeft = ctx;
                    continue;
                }
            }
            if (afterLeft > 0 && budget > 0) {
                matches.push({ line: n, text: line });
                budget -= line.length;
                afterLeft--;
                continue;
            }
            before.push({ n, t: line });
            if (before.length > ctx) before.shift();
        }
        return {
            job_id: job.spec.id,
            status: job.state.status,
            log_bytes: size,
            grep: o.grep,
            total_matches: total,
            shown_matches: Math.min(total, maxMatches),
            lines: matches.map(m => `${m.line}: ${m.text}`).join('\n'),
        };
    }

    if (o.offset !== undefined && o.offset !== null) {
        const start = Math.max(0, Math.min(o.offset, size));
        const limitEnd = range ? Math.min(range.end, size) : size;
        let text = readRange(file, start, Math.min(maxBytes, limitEnd - start));
        let consumed = Buffer.byteLength(text, 'utf8');
        if (start + consumed < limitEnd) {
            const nl = text.lastIndexOf('\n');
            if (nl > 0) { text = text.slice(0, nl + 1); consumed = Buffer.byteLength(text, 'utf8'); }
        }
        return {
            job_id: job.spec.id,
            status: job.state.status,
            log_bytes: size,
            offset: start,
            next_offset: start + consumed,
            eof: start + consumed >= limitEnd,
            text: stripAnsi(text),
        };
    }

    const tailLines = Math.min(Math.max(o.tail_lines ?? 120, 1), 5000);
    if (range) {
        const len = range.end - range.start;
        const from = len > maxBytes ? range.end - maxBytes : range.start;
        let text = readRange(file, from, range.end - from);
        const lines = text.split('\n');
        if (lines.length > tailLines) text = lines.slice(-tailLines).join('\n');
        return { job_id: job.spec.id, status: job.state.status, log_bytes: size, step: o.step, text: stripAnsi(text) };
    }
    const t = tailFile(file, tailLines, maxBytes);
    return {
        job_id: job.spec.id,
        status: job.state.status,
        log_bytes: size,
        tail_start_offset: t.start,
        truncated_before: t.start > 0,
        text: stripAnsi(t.text),
    };
}

/**
 * Wait (bounded) for a job to finish or for a pattern to appear in new output.
 * Never blocks longer than `timeoutSec` so an MCP call cannot time out.
 */
export async function waitJob(id: string, timeoutSec: number, sinceOffset?: number, untilPattern?: string): Promise<Record<string, any>> {
    let job = requireJob(id);
    const file = logPath(job);
    const since = sinceOffset ?? fileSize(file);
    const deadline = Date.now() + timeoutSec * 1000;
    let re: RegExp | null = null;
    if (untilPattern) {
        try { re = new RegExp(untilPattern, 'i'); } catch { re = new RegExp(untilPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    }
    let matched = false;
    let scanned = since;
    while (true) {
        job = requireJob(id);
        if (isTerminal(job)) break;
        if (re) {
            const size = fileSize(file);
            if (size > scanned) {
                // re-scan a small overlap so matches across chunk boundaries are found
                const from = Math.max(since, scanned - 512);
                const chunk = stripAnsi(readRange(file, from, Math.min(size - from, 4 * 1024 * 1024)));
                if (re.test(chunk)) { matched = true; break; }
                scanned = size;
            }
        }
        if (Date.now() >= deadline) break;
        await sleep(Math.min(500, Math.max(50, deadline - Date.now())));
    }
    const size = fileSize(file);
    // Without since_offset show the recent tail of the log (what a human would glance at).
    const displayFrom = sinceOffset ?? 0;
    const newBytes = Math.max(0, size - displayFrom);
    const maxShow = 6000;
    const showFrom = newBytes > maxShow ? size - maxShow : displayFrom;
    let out = stripAnsi(readRange(file, showFrom, size - showFrom));
    if (newBytes > maxShow) {
        const nl = out.indexOf('\n');
        out = `…[${showFrom} earlier bytes omitted — use job_logs(offset=…) or grep]\n` + (nl >= 0 ? out.slice(nl + 1) : out);
    }
    return {
        ...summarize(job),
        finished: isTerminal(job),
        pattern_matched: re ? matched : undefined,
        new_output: out,
        next_offset: size,
    };
}

export async function cancelJob(id: string, waitMs = 6000) {
    let job = requireJob(id);
    if (isTerminal(job)) return { ...summarize(job), note: 'Job already finished.' };
    fs.writeFileSync(path.join(job.dir, 'cancel'), new Date().toISOString());
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        await sleep(250);
        job = requireJob(id);
        if (isTerminal(job)) return summarize(job);
    }
    // Runner unresponsive: kill directly.
    if (job.state.pid) killTree(job.state.pid, 'SIGKILL');
    if (job.state.runner_pid) killTree(job.state.runner_pid, 'SIGKILL');
    job.state.status = 'cancelled';
    job.state.finished_at = new Date().toISOString();
    job.state.error = 'Force-killed after runner did not respond to cancel.';
    writeJsonAtomic(path.join(job.dir, 'state.json'), job.state);
    return summarize(job);
}

export function cleanupJobs(olderThanDays: number): { removed: string[] } {
    const removed: string[] = [];
    const cutoff = Date.now() - olderThanDays * 86400000;
    for (const id of listJobIds()) {
        const j = loadJob(id);
        if (!j || !isTerminal(j)) continue;
        const t = Date.parse(j.state.finished_at || j.spec.created_at);
        if (t < cutoff) {
            try {
                fs.rmSync(j.dir, { recursive: true, force: true });
                if (j.spec.request_key) fs.rmSync(keyFile(j.spec.request_key), { force: true });
                removed.push(id);
            } catch { /* ignore */ }
        }
    }
    return { removed };
}

export function listArtifacts(job: Job): Array<{ path: string; bytes: number }> {
    const root = path.join(job.dir, 'artifacts');
    const out: Array<{ path: string; bytes: number }> = [];
    const walk = (d: string) => {
        let ents: fs.Dirent[] = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (out.length < 200) out.push({ path: p, bytes: fileSize(p) });
        }
    };
    walk(root);
    return out;
}
