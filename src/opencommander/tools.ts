/**
 * OpenCommander tool definitions + handlers.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getConfig, ocHome } from './config.js';
import {
    cancelJob, cleanupJobs, isTerminal, Job, listArtifacts, listJobs, loadJob, logPath, readLogs, requireJob,
    startJob, StartJobOptions, summarize, waitJob,
} from './jobs/manager.js';
import { JobStep } from './jobs/types.js';
import { detectProject } from './detect.js';
import { errorExcerpt, parseDiagnostics, parseTestOutput } from './parsers.js';
import * as gitx from './git.js';
import * as intel from './intel.js';
import { getTask, listTasks, saveTask } from './tasks.js';
import { getApproval, listApprovals } from './security/approvals.js';
import { readAudit } from './audit.js';
import { WORKFLOW_GUIDE } from './instructions.js';
import { asInt, fail, fileSize, ok, readRange, ToolError, ToolResult } from './util.js';
import { VERSION } from '../version.js';

export const OC_VERSION = `${VERSION}-oc1`;

// ------------------------------------------------------------------ schemas

const approvalId = z.string().optional().describe('Only when retrying a call that returned APPROVAL_REQUIRED after the user approved it.');
const waitSeconds = z.number().optional().describe('Max seconds to wait synchronously (0-55, default 40). If still running you get a job_id to poll with job_wait.');
const requestKey = z.string().optional().describe('Idempotency key. Re-sending the same key returns the existing job instead of starting a duplicate. Use e.g. "<task>-<step>-<attempt>".');

const StepSchema = z.object({
    name: z.string(),
    command: z.string(),
    parser: z.string().optional().describe('pytest | jest | vitest | go | cargo | mocha | tap | jvm | unittest | diagnostics'),
    allow_failure: z.boolean().optional(),
});

const S = {
    session_start: z.object({
        path: z.string().optional().describe('Optional repo path to include a quick status for.'),
    }),
    task_state_save: z.object({
        task_id: z.string().describe('Short stable id, e.g. "fix-reviewer-schema".'),
        title: z.string().optional(),
        repo: z.string().optional(),
        goal: z.string().optional(),
        status: z.enum(['active', 'blocked', 'done', 'abandoned']).optional(),
        plan: z.array(z.string()).optional(),
        next_steps: z.array(z.string()).optional(),
        append_done: z.array(z.string()).optional().describe('Steps just completed (appended).'),
        notes: z.string().optional().describe('Durable notes: decisions, findings, file locations, commands that work.'),
        progress_note: z.string().optional().describe('One-line log entry for this update.'),
        related_jobs: z.array(z.string()).optional(),
        checkpoints: z.array(z.string()).optional(),
    }),
    task_state_get: z.object({
        task_id: z.string().optional().describe('Omit to list tasks.'),
        status: z.enum(['active', 'blocked', 'done', 'abandoned', 'all']).optional(),
    }),
    approval_status: z.object({ approval_id: z.string().optional().describe('Omit to list pending approvals.') }),
    audit_log: z.object({ limit: z.number().optional(), tool: z.string().optional() }),

    job_start: z.object({
        command: z.string().optional().describe('Shell command. Windows default shell: PowerShell; macOS/Linux: bash.'),
        steps: z.array(StepSchema).optional().describe('Run several commands sequentially as ONE job (instead of command).'),
        cwd: z.string().describe('Absolute working directory.'),
        shell: z.string().optional().describe('auto | powershell | pwsh | cmd | bash | sh'),
        env: z.record(z.string()).optional(),
        timeout_seconds: z.number().optional().describe('Kill after N seconds (default: no limit).'),
        request_key: requestKey,
        label: z.string().optional(),
        continue_on_failure: z.boolean().optional(),
        wait_seconds: z.number().optional().describe('Wait up to N seconds (0-55, default 0) and include output if it finishes quickly.'),
        approval_id: approvalId,
    }),
    job_status: z.object({ job_id: z.string() }),
    job_wait: z.object({
        job_id: z.string(),
        timeout_seconds: z.number().optional().describe('1-55, default 30.'),
        since_offset: z.number().optional().describe('Show output after this byte offset (use next_offset from the previous call).'),
        until_pattern: z.string().optional().describe('Return early when this regex appears in new output (e.g. "Listening on").'),
    }),
    job_logs: z.object({
        job_id: z.string(),
        offset: z.number().optional().describe('Byte offset to page forward from (returns next_offset).'),
        max_bytes: z.number().optional(),
        tail_lines: z.number().optional().describe('Default mode: last N lines (default 120).'),
        grep: z.string().optional().describe('Regex filter over the whole log, with context lines.'),
        context: z.number().optional(),
        step: z.union([z.string(), z.number()]).optional().describe('Restrict to one step of a multi-step job.'),
    }),
    job_result: z.object({ job_id: z.string(), parser: z.string().optional() }),
    job_cancel: z.object({ job_id: z.string() }),
    job_list: z.object({
        status: z.string().optional().describe('active | finished | running | succeeded | failed | cancelled | timed_out | lost'),
        cwd: z.string().optional(),
        limit: z.number().optional(),
    }),
    job_cleanup: z.object({ older_than_days: z.number().optional() }),

    repo_status: z.object({ path: z.string() }),
    repo_diff: z.object({
        path: z.string(),
        staged: z.boolean().optional(),
        base: z.string().optional().describe('Compare working tree to a commit/branch/checkpoint commit.'),
        files: z.array(z.string()).optional(),
        stat_only: z.boolean().optional(),
        context: z.number().optional(),
        offset_lines: z.number().optional(),
        max_lines: z.number().optional(),
    }),
    patch_preview: z.object({ path: z.string().describe('Repo/dir the patch paths are relative to.'), patch: z.string().describe('Unified diff (git diff format).'), reverse: z.boolean().optional() }),
    patch_apply: z.object({
        path: z.string(),
        patch: z.string().describe('Unified diff (git diff format, a/ b/ prefixes).'),
        checkpoint: z.boolean().optional().describe('Create a git checkpoint first (default true in git repos).'),
        three_way: z.boolean().optional(),
        reverse: z.boolean().optional(),
        approval_id: approvalId,
    }),
    test_run: z.object({
        path: z.string().describe('Project root (or any dir inside it).'),
        command: z.string().optional().describe('Override the detected test command.'),
        args: z.string().optional().describe('Extra args appended to the detected command, e.g. "-k reviewer" or a test file path.'),
        parser: z.string().optional(),
        wait_seconds: waitSeconds,
        timeout_seconds: z.number().optional(),
        request_key: requestKey,
        approval_id: approvalId,
    }),
    lint_run: z.object({
        path: z.string(),
        command: z.string().optional(),
        include_typecheck: z.boolean().optional().describe('Also run the detected typecheck (default true).'),
        wait_seconds: waitSeconds,
        request_key: requestKey,
        approval_id: approvalId,
    }),
    build_run: z.object({
        path: z.string(),
        command: z.string().optional(),
        wait_seconds: waitSeconds,
        timeout_seconds: z.number().optional(),
        request_key: requestKey,
        approval_id: approvalId,
    }),
    repo_verify: z.object({
        path: z.string(),
        checks: z.array(z.enum(['lint', 'typecheck', 'test', 'build', 'deps'])).optional().describe('Default: lint, typecheck, test (+deps for Python).'),
        steps: z.array(StepSchema).optional().describe('Custom steps instead of detected checks.'),
        test_args: z.string().optional(),
        wait_seconds: waitSeconds,
        timeout_seconds: z.number().optional(),
        request_key: requestKey,
        approval_id: approvalId,
    }),
    git_checkpoint: z.object({ path: z.string(), message: z.string().optional() }),
    git_checkpoint_list: z.object({ path: z.string(), limit: z.number().optional() }),
    git_rollback: z.object({
        path: z.string(),
        checkpoint_id: z.string(),
        paths: z.array(z.string()).optional().describe('Only roll back these repo-relative paths.'),
        approval_id: approvalId,
    }),

    repo_overview: z.object({ path: z.string(), depth: z.number().optional() }),
    repo_find_symbol: z.object({
        path: z.string(),
        name: z.string().describe('Identifier, e.g. ReviewerResult or Service.run'),
        include_references: z.boolean().optional(),
        max_references: z.number().optional(),
        glob: z.string().optional().describe('Limit files, e.g. "*.py" or "src/**"'),
    }),
    repo_outline: z.object({ file: z.string() }),
    repo_related: z.object({ file: z.string() }),
    repo_search: z.object({
        path: z.string(),
        query: z.string(),
        regex: z.boolean().optional(),
        glob: z.string().optional().describe('Comma-separated globs, e.g. "*.ts,!*.test.ts"'),
        case_sensitive: z.boolean().optional(),
        context: z.number().optional(),
        max_results: z.number().optional(),
        max_per_file: z.number().optional(),
        files_only: z.boolean().optional(),
    }),
    read_ranges: z.object({
        items: z.array(z.object({ path: z.string(), start_line: z.number().optional(), end_line: z.number().optional() })).describe('Up to 30 files/ranges in one call. Lines are 1-based, inclusive. Default: first 200 lines.'),
        max_chars: z.number().optional(),
    }),
};

export type OcToolName = keyof typeof S;

interface Ann { title: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }

const DEFS: Record<OcToolName, { description: string; annotations: Ann }> = {
    session_start: { description: 'START HERE. Returns the workflow rules, machine info, running/recent jobs, saved task states and pending approvals. Call at the beginning of every chat and after any disconnect.', annotations: { title: 'Start / resume session', readOnlyHint: true } },
    task_state_save: { description: 'Persist task progress (goal, plan, done, next steps, notes) so work can resume after a chat timeout or reload. Call after each meaningful step.', annotations: { title: 'Save task state', readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
    task_state_get: { description: 'Load a saved task state (to resume work) or list tasks when task_id is omitted.', annotations: { title: 'Get task state', readOnlyHint: true } },
    approval_status: { description: 'Check an approval request (or list pending ones). Approvals are granted by the human outside ChatGPT.', annotations: { title: 'Approval status', readOnlyHint: true } },
    audit_log: { description: 'Recent audited tool calls (masked).', annotations: { title: 'Audit log', readOnlyHint: true } },

    job_start: { description: 'Start a persistent background job (shell command or multi-step). Returns immediately with job_id; the job survives ChatGPT disconnects, browser reloads and MCP server restarts. Use for anything that may take > 30 s. Pass request_key for idempotent retries.', annotations: { title: 'Start background job', readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
    job_status: { description: 'Status of a job (running/succeeded/failed/…), pid, elapsed time, heartbeat, current step.', annotations: { title: 'Job status', readOnlyHint: true } },
    job_wait: { description: 'Wait up to timeout_seconds (≤55) for a job to finish or for until_pattern to appear; returns status + new output. Safe way to "block" without MCP timeouts.', annotations: { title: 'Wait for job', readOnlyHint: true } },
    job_logs: { description: 'Read job output: tail (default), page by byte offset, grep with context, or a single step. Output is ANSI-stripped and secret-masked.', annotations: { title: 'Job logs', readOnlyHint: true } },
    job_result: { description: 'Final result of a finished job with parsed test/diagnostic summary, error excerpt and artifacts.', annotations: { title: 'Job result', readOnlyHint: true } },
    job_cancel: { description: 'Cancel a running job (kills its whole process tree).', annotations: { title: 'Cancel job', readOnlyHint: false, destructiveHint: true } },
    job_list: { description: 'List jobs (newest first), filter by status (active|finished|…) or cwd.', annotations: { title: 'List jobs', readOnlyHint: true } },
    job_cleanup: { description: 'Delete finished jobs older than N days (default from config).', annotations: { title: 'Cleanup jobs', readOnlyHint: false, destructiveHint: true } },

    repo_status: { description: 'Git status summary: branch, ahead/behind, staged/unstaged/untracked/conflicted files, recent commits, in-progress merge/rebase, checkpoints.', annotations: { title: 'Repo status', readOnlyHint: true } },
    repo_diff: { description: 'Git diff with stats (unstaged, staged, or vs a base ref), paginated by lines. Lists untracked files.', annotations: { title: 'Repo diff', readOnlyHint: true } },
    patch_preview: { description: 'Validate a unified diff without applying it (git apply --check) and show its stat.', annotations: { title: 'Preview patch', readOnlyHint: true } },
    patch_apply: { description: 'Apply a unified diff (multi-file, multi-hunk). Creates a git checkpoint first; falls back to 3-way merge. Use for larger edits; edit_block for small ones.', annotations: { title: 'Apply patch', readOnlyHint: false, destructiveHint: true } },
    test_run: { description: 'Run the project tests (auto-detected: pytest, jest, vitest, go, cargo, gradle, maven, dotnet…) and return a STRUCTURED summary: counts + failing tests with file:line and message. Auto-backgrounds after wait_seconds.', annotations: { title: 'Run tests', readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    lint_run: { description: 'Run detected linter (+ typecheck) and return structured diagnostics (file:line:col, code, message).', annotations: { title: 'Run lint/typecheck', readOnlyHint: false, destructiveHint: false } },
    build_run: { description: 'Run the detected build and return structured compiler diagnostics.', annotations: { title: 'Run build', readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    repo_verify: { description: 'ONE call verification: runs lint, typecheck, tests (and optionally build/deps) as a single job and returns an overall pass/fail with per-check structured results plus changed files. Use after every change set.', annotations: { title: 'Verify repository', readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    git_checkpoint: { description: 'Snapshot the whole working tree (incl. untracked files) to a hidden git ref without touching HEAD, index, branches or stash. Returns checkpoint_id for git_rollback.', annotations: { title: 'Git checkpoint', readOnlyHint: false, destructiveHint: false } },
    git_checkpoint_list: { description: 'List OpenCommander checkpoints of a repo.', annotations: { title: 'List checkpoints', readOnlyHint: true } },
    git_rollback: { description: 'Restore the working tree (and index) to a checkpoint. Automatically checkpoints the current state first so the rollback itself can be undone.', annotations: { title: 'Rollback to checkpoint', readOnlyHint: false, destructiveHint: true } },

    repo_overview: { description: 'One-call repo orientation: languages, directory tree with counts, manifests, entrypoints, detected test/lint/build commands, git state, README head.', annotations: { title: 'Repo overview', readOnlyHint: true } },
    repo_find_symbol: { description: 'Find where a symbol (class/function/type/const) is defined and referenced, across languages. Groups test references separately.', annotations: { title: 'Find symbol', readOnlyHint: true } },
    repo_outline: { description: 'Outline of a source file (classes, functions, methods with line numbers) — read structure before reading code.', annotations: { title: 'File outline', readOnlyHint: true } },
    repo_related: { description: 'For a file: its local imports, who imports it, and its tests (or, for a test file, the sources under test).', annotations: { title: 'Related files/tests', readOnlyHint: true } },
    repo_search: { description: 'Fast ripgrep search (literal by default, regex optional) with globs and context, grouped compact output, respects .gitignore.', annotations: { title: 'Search code', readOnlyHint: true } },
    read_ranges: { description: 'Read specific line ranges from many files in one call (line-numbered). Prefer over reading whole files.', annotations: { title: 'Read line ranges', readOnlyHint: true } },
};

export const OC_TOOL_NAMES = new Set<string>(Object.keys(S));

export function getOcToolDefinitions() {
    return (Object.keys(S) as OcToolName[]).map(name => ({
        name,
        description: DEFS[name].description,
        inputSchema: zodToJsonSchema(S[name]) as Record<string, unknown>,
        annotations: DEFS[name].annotations,
    }));
}

export function isReadOnlyTool(name: string): boolean {
    return !!(DEFS as any)[name]?.annotations?.readOnlyHint;
}

// ------------------------------------------------------------------ helpers

function clampWait(v: unknown, def: number): number {
    const cfg = getConfig();
    const hardMax = Math.max(5, Math.min(55, cfg.http.tool_call_timeout_seconds - 10));
    return asInt(v, def, 0, hardMax);
}

async function projectRoot(p: string): Promise<string> {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) throw new ToolError(`Path does not exist: ${abs}`);
    const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    // prefer the nearest dir with a manifest, else the git root, else dir
    let cur = dir;
    const markers = ['package.json', 'pyproject.toml', 'setup.py', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'requirements.txt', 'Makefile'];
    const gitRoot = await gitx.repoRoot(dir);
    while (true) {
        if (markers.some(m => fs.existsSync(path.join(cur, m)))) return cur;
        if (gitRoot && path.resolve(cur) === path.resolve(gitRoot)) return cur;
        const up = path.dirname(cur);
        if (up === cur) return dir;
        cur = up;
    }
}

function readWholeLog(job: Job, maxBytes = 8 * 1024 * 1024): string {
    const f = logPath(job);
    const size = fileSize(f);
    const start = Math.max(0, size - maxBytes);
    return readRange(f, start, size - start);
}

function stepText(job: Job, idx: number): string {
    const s = job.state.steps[idx];
    const f = logPath(job);
    if (!s || s.log_start === undefined) return '';
    const end = s.log_end ?? fileSize(f);
    const start = Math.max(s.log_start, end - 8 * 1024 * 1024);
    return readRange(f, start, end - start);
}

function analyze(text: string, parser: string | undefined, kind: string, failed: boolean) {
    const out: Record<string, unknown> = {};
    if (parser === 'diagnostics' || (!parser && ['lint', 'build', 'typecheck'].includes(kind))) {
        const d = parseDiagnostics(text);
        out.diagnostics = { errors: d.errors, warnings: d.warnings, files_with_issues: d.files_with_issues, items: d.items };
        if (failed && !d.items.length) out.error_excerpt = errorExcerpt(text);
        return out;
    }
    if (parser || kind === 'test') {
        const t = parseTestOutput(text, parser);
        if (t.parsed) out.tests = t;
        else {
            const d = parseDiagnostics(text);
            if (d.items.length) out.diagnostics = { errors: d.errors, warnings: d.warnings, items: d.items.slice(0, 30) };
            if (failed || !d.items.length) out.error_excerpt = errorExcerpt(text);
            out.note = 'Could not parse test summary; see error_excerpt or job_logs.';
        }
        return out;
    }
    if (failed) {
        const d = parseDiagnostics(text);
        if (d.items.length) out.diagnostics = { errors: d.errors, warnings: d.warnings, items: d.items.slice(0, 30) };
        out.error_excerpt = errorExcerpt(text);
    }
    return out;
}

export async function buildJobResult(job: Job, parserOverride?: string) {
    const base = summarize(job);
    if (!isTerminal(job)) {
        return { ...base, finished: false, hint: `Still running. Call job_wait("${job.spec.id}") to keep waiting.` };
    }
    const failed = job.state.status !== 'succeeded';
    const res: Record<string, unknown> = { ...base, finished: true };
    const steps = job.spec.steps;
    if (steps.length > 1 || job.spec.kind === 'verify') {
        const per: Array<Record<string, unknown>> = [];
        steps.forEach((s, i) => {
            const st = job.state.steps[i];
            const entry: Record<string, unknown> = { name: s.name, command: s.command, status: st?.status, exit_code: st?.exit_code, seconds: st?.duration_ms !== undefined ? Math.round(st.duration_ms / 100) / 10 : undefined };
            if (st && st.status !== 'skipped' && st.status !== 'pending') {
                const kind = s.name === 'test' ? 'test' : ['lint', 'typecheck', 'build'].includes(s.name) ? s.name : 'shell';
                Object.assign(entry, analyze(stepText(job, i), s.parser, kind, st.status !== 'succeeded'));
            }
            per.push(entry);
        });
        res.checks = per;
    } else {
        Object.assign(res, analyze(readWholeLog(job), parserOverride || steps[0]?.parser, job.spec.kind, failed));
        if (!failed && !res.tests && !res.diagnostics) {
            const tail: any = await readLogs(job, { tail_lines: 25, max_bytes: 4000 });
            res.output_tail = tail.text;
        }
    }
    const arts = listArtifacts(job);
    if (arts.length) res.artifacts = arts;
    return res;
}

async function runAndReport(opts: StartJobOptions, waitSec: number, parser?: string, extra?: (job: Job) => Promise<Record<string, unknown>>) {
    const { job, deduplicated, dedupe_reason } = startJob(opts);
    const w = await waitJob(job.spec.id, waitSec, 0);
    const fresh = requireJob(job.spec.id);
    if (!w.finished) {
        return {
            job_id: job.spec.id,
            status: fresh.state.status,
            finished: false,
            deduplicated: deduplicated || undefined,
            dedupe_reason,
            elapsed_seconds: w.elapsed_seconds,
            stage: w.stage,
            output_so_far: String(w.new_output || '').split('\n').slice(-15).join('\n'),
            next: `Still running in the background (safe from timeouts). Call job_wait("${job.spec.id}", timeout_seconds=50) and then job_result("${job.spec.id}").`,
        };
    }
    const result = await buildJobResult(fresh, parser);
    if (deduplicated) { (result as any).deduplicated = true; (result as any).dedupe_reason = dedupe_reason; }
    if (extra) Object.assign(result, await extra(fresh));
    return result;
}

function detectOrThrow(root: string, which: 'test' | 'lint' | 'build' | 'typecheck', shell: string) {
    const info = detectProject(root, shell);
    const c = info[which];
    if (!c) throw new ToolError(`Could not detect a ${which} command for ${root}.`, { detected_types: info.types, hint: `Pass command explicitly, e.g. ${which}_run(path, command="...")` });
    return { info, cmd: c };
}

async function changedFiles(root: string) {
    try {
        const s = await gitx.status(root, 40);
        return { changed_files: s.counts, files: [...s.staged, ...s.unstaged, ...s.untracked.map(u => `? ${u}`)].slice(0, 40) };
    } catch { return {}; }
}

// ------------------------------------------------------------------ dispatcher

export async function callOcTool(name: string, rawArgs: unknown): Promise<ToolResult> {
    const schema = (S as any)[name] as z.ZodTypeAny | undefined;
    if (!schema) return fail(`Unknown tool ${name}`);
    const parsed = schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
        return fail('Invalid arguments', { issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) });
    }
    const a: any = parsed.data;
    const cfg = getConfig();
    try {
        switch (name as OcToolName) {
            case 'session_start': {
                const active = listJobs({ status: 'active', limit: 20 }).map(summarize);
                const recent = listJobs({ status: 'finished', limit: 8 }).map(j => { const s = summarize(j); return { job_id: s.job_id, status: s.status, label: s.label, command: s.command, finished_at: s.finished_at }; });
                const res: Record<string, unknown> = {
                    server: { name: 'OpenCommander', version: OC_VERSION, host: os.hostname(), platform: `${process.platform} ${os.release()}`, arch: process.arch, node: process.version, home: os.homedir(), default_job_shell: cfg.jobs.shell === 'auto' ? (process.platform === 'win32' ? 'powershell' : 'bash') : cfg.jobs.shell, security_profile: cfg.security.profile, allowed_roots: cfg.security.allowed_roots.length ? cfg.security.allowed_roots : 'any (protected paths still blocked)', approvals_dashboard: `http://127.0.0.1:${((global as any).__ocAdminPort || cfg.http.admin_port)}/` },
                    workflow: WORKFLOW_GUIDE.replace('http://127.0.0.1:7801', `http://127.0.0.1:${((global as any).__ocAdminPort || cfg.http.admin_port)}`),
                    running_jobs: active,
                    recent_jobs: recent,
                    tasks: listTasks('active', 10),
                    pending_approvals: listApprovals('pending', 10).map(x => ({ id: x.id, tool: x.tool, summary: x.summary.slice(0, 200), created_at: x.created_at })),
                };
                if (a.path) {
                    try { res.repo = await intel.overview(a.path, 1); } catch (e) { res.repo = { error: (e as Error).message }; }
                }
                return ok(res);
            }
            case 'task_state_save': {
                const t = saveTask(a);
                return ok({ saved: true, task_id: t.task_id, status: t.status, updated_at: t.updated_at, done_count: t.done?.length || 0, next_steps: t.next_steps });
            }
            case 'task_state_get': {
                if (!a.task_id) return ok({ tasks: listTasks(a.status || 'active', 30) });
                const t = getTask(a.task_id);
                if (!t) return fail(`Task not found: ${a.task_id}`, { tasks: listTasks('all', 20) });
                const jobs = (t.related_jobs || []).slice(-10).map(id => { const j = loadJob(id); return j ? summarize(j) : { job_id: id, status: 'unknown' }; });
                return ok({ ...t, history: t.history.slice(-15), related_jobs_status: jobs });
            }
            case 'approval_status': {
                if (!a.approval_id) return ok({ pending: listApprovals('pending', 30) });
                const x = getApproval(a.approval_id);
                return x ? ok(x) : fail(`approval ${a.approval_id} not found`);
            }
            case 'audit_log':
                return ok({ entries: readAudit(asInt(a.limit, 30, 1, 500), a.tool) });

            // ---------------- jobs
            case 'job_start': {
                const r = startJob({
                    command: a.command, steps: a.steps, cwd: a.cwd, shell: a.shell, env: a.env,
                    timeout_seconds: a.timeout_seconds, request_key: a.request_key, label: a.label,
                    continue_on_failure: a.continue_on_failure, kind: 'shell',
                });
                const wait = clampWait(a.wait_seconds, 0);
                if (wait > 0) {
                    const w = await waitJob(r.job.spec.id, wait, 0);
                    return ok({ ...w, deduplicated: r.deduplicated || undefined, dedupe_reason: r.dedupe_reason });
                }
                return ok({
                    ...summarize(requireJob(r.job.spec.id)),
                    deduplicated: r.deduplicated || undefined,
                    dedupe_reason: r.dedupe_reason,
                    next: `Poll with job_wait("${r.job.spec.id}") — returns within ≤55 s.`,
                });
            }
            case 'job_status':
                return ok(summarize(requireJob(a.job_id)));
            case 'job_wait': {
                const r = await waitJob(a.job_id, clampWait(a.timeout_seconds, 30) || 1, a.since_offset, a.until_pattern);
                return ok({ ...r, hint: r.finished ? `Finished. Call job_result("${a.job_id}") for the parsed summary.` : undefined });
            }
            case 'job_logs':
                return ok(await readLogs(requireJob(a.job_id), a));
            case 'job_result':
                return ok(await buildJobResult(requireJob(a.job_id), a.parser));
            case 'job_cancel':
                return ok(await cancelJob(a.job_id));
            case 'job_list':
                return ok({ jobs: listJobs({ status: a.status, cwd: a.cwd, limit: asInt(a.limit, 20, 1, 200) }).map(summarize) });
            case 'job_cleanup':
                return ok(cleanupJobs(asInt(a.older_than_days, cfg.jobs.retention_days, 0, 3650)));

            // ---------------- git / patches
            case 'repo_status':
                return ok(await gitx.status(await gitx.requireRepo(a.path)));
            case 'repo_diff':
                return ok(await gitx.diff(await gitx.requireRepo(a.path), a));
            case 'patch_preview': {
                const dir = path.resolve(a.path);
                const root = (await gitx.repoRoot(dir)) || dir;
                return ok(await gitx.applyPatch(root, a.patch, { check_only: true, reverse: a.reverse }));
            }
            case 'patch_apply': {
                const dir = path.resolve(a.path);
                const root = (await gitx.repoRoot(dir)) || dir;
                const isRepo = !!(await gitx.repoRoot(dir));
                let checkpoint: string | undefined;
                if (isRepo && a.checkpoint !== false) checkpoint = (await gitx.createCheckpoint(root, 'auto: before patch_apply')).id;
                const r = await gitx.applyPatch(root, a.patch, { three_way: a.three_way, reverse: a.reverse });
                const res: Record<string, unknown> = { ...r, checkpoint_id: checkpoint };
                if (r.ok && isRepo) Object.assign(res, await changedFiles(root));
                return r.ok ? ok(res) : fail('Patch did not apply', res);
            }

            // ---------------- runners
            case 'test_run': {
                const root = await projectRoot(a.path);
                let command = a.command as string | undefined;
                let parser = a.parser as string | undefined;
                if (!command) {
                    const { cmd } = detectOrThrow(root, 'test', cfg.jobs.shell);
                    command = cmd.command;
                    parser = parser || cmd.parser;
                    if (a.args) command += (/^npm test$|^(pnpm|yarn|bun) test$/.test(command) ? ' -- ' : ' ') + a.args;
                }
                return ok(await runAndReport({ command, cwd: root, label: 'test', kind: 'test', request_key: a.request_key, timeout_seconds: a.timeout_seconds, steps: [{ name: 'test', command, parser }] }, clampWait(a.wait_seconds, cfg.jobs.default_wait_seconds), parser));
            }
            case 'lint_run': {
                const root = await projectRoot(a.path);
                const steps: JobStep[] = [];
                if (a.command) steps.push({ name: 'lint', command: a.command, parser: 'diagnostics', allow_failure: false });
                else {
                    const info = detectProject(root, cfg.jobs.shell);
                    if (info.lint) steps.push({ name: 'lint', command: info.lint.command, parser: 'diagnostics' });
                    if (a.include_typecheck !== false && info.typecheck) steps.push({ name: 'typecheck', command: info.typecheck.command, parser: 'diagnostics' });
                    if (!steps.length) throw new ToolError('No linter/typecheck detected.', { detected_types: info.types, hint: 'Pass command, e.g. "npx eslint ." or "python -m ruff check ."' });
                }
                return ok(await runAndReport({ steps, cwd: root, label: 'lint', kind: 'lint', request_key: a.request_key, continue_on_failure: true }, clampWait(a.wait_seconds, cfg.jobs.default_wait_seconds), 'diagnostics'));
            }
            case 'build_run': {
                const root = await projectRoot(a.path);
                const command = a.command || detectOrThrow(root, 'build', cfg.jobs.shell).cmd.command;
                return ok(await runAndReport({ steps: [{ name: 'build', command, parser: 'diagnostics' }], cwd: root, label: 'build', kind: 'build', request_key: a.request_key, timeout_seconds: a.timeout_seconds }, clampWait(a.wait_seconds, cfg.jobs.default_wait_seconds), 'diagnostics'));
            }
            case 'repo_verify': {
                const root = await projectRoot(a.path);
                let steps: JobStep[] = a.steps || [];
                const info = detectProject(root, cfg.jobs.shell);
                if (!steps.length) {
                    const checks: string[] = a.checks || ['lint', 'typecheck', 'test', ...(info.types.includes('python') ? ['deps'] : [])];
                    for (const c of checks) {
                        if (c === 'lint' && info.lint) steps.push({ name: 'lint', command: info.lint.command, parser: 'diagnostics' });
                        if (c === 'typecheck' && info.typecheck) steps.push({ name: 'typecheck', command: info.typecheck.command, parser: 'diagnostics' });
                        if (c === 'test' && info.test) steps.push({ name: 'test', command: info.test.command + (a.test_args ? ' ' + a.test_args : ''), parser: info.test.parser });
                        if (c === 'build' && info.build) steps.push({ name: 'build', command: info.build.command, parser: 'diagnostics' });
                        if (c === 'deps' && info.deps_check) steps.push({ name: 'deps', command: info.deps_check.command });
                    }
                }
                if (!steps.length) throw new ToolError('Nothing to verify: no lint/typecheck/test/build detected.', { detected_types: info.types, hint: 'Pass steps=[{name,command}]' });
                const res: any = await runAndReport(
                    { steps, cwd: root, label: 'verify', kind: 'verify', request_key: a.request_key, continue_on_failure: true, timeout_seconds: a.timeout_seconds },
                    clampWait(a.wait_seconds, cfg.jobs.default_wait_seconds), undefined,
                    async () => changedFiles(root),
                );
                if (res.finished) {
                    const checks = (res.checks || []) as Array<any>;
                    res.overall = checks.every(c => c.status === 'succeeded') ? 'passed' : 'failed';
                    res.summary = checks.map(c => {
                        let s = `${c.name}: ${c.status}`;
                        if (c.tests) s += ` (${c.tests.passed ?? '?'} passed, ${c.tests.failed ?? 0} failed${c.tests.errors ? `, ${c.tests.errors} errors` : ''})`;
                        else if (c.diagnostics) s += ` (${c.diagnostics.errors} errors, ${c.diagnostics.warnings} warnings)`;
                        return s;
                    });
                }
                return ok(res);
            }
            case 'git_checkpoint': {
                const root = await gitx.requireRepo(a.path);
                return ok({ ...(await gitx.createCheckpoint(root, a.message || '')), root, hint: 'Pass this checkpoint_id to git_rollback to restore.' });
            }
            case 'git_checkpoint_list': {
                const root = await gitx.requireRepo(a.path);
                return ok({ root, checkpoints: await gitx.listCheckpoints(root, asInt(a.limit, 20, 1, 200)) });
            }
            case 'git_rollback': {
                const root = await gitx.requireRepo(a.path);
                return ok(await gitx.rollback(root, a.checkpoint_id, a.paths));
            }

            // ---------------- intelligence
            case 'repo_overview':
                return ok(await intel.overview(a.path, asInt(a.depth, 2, 1, 4)));
            case 'repo_find_symbol':
                return ok(await intel.findSymbol(a.path, a.name, a));
            case 'repo_outline':
                return ok(intel.outline(path.resolve(a.file)));
            case 'repo_related':
                return ok(await intel.related(a.file));
            case 'repo_search':
                return ok(await intel.search(a.path, a.query, a));
            case 'read_ranges':
                return ok({ results: intel.readRanges(a.items.map((i: any) => ({ ...i, path: path.resolve(i.path) })), asInt(a.max_chars, 50000, 1000, 200000)) });
        }
        return fail(`Unhandled tool ${name}`);
    } catch (e) {
        if (e instanceof ToolError) return fail(e.message, e.extra);
        return fail((e as Error)?.message || String(e));
    }
}

export { ocHome };
