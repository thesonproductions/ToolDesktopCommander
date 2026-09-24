/**
 * Git helpers: status/diff summaries and safe checkpoints.
 *
 * A checkpoint snapshots the *entire working tree* (tracked + untracked,
 * respecting .gitignore) into a commit object stored under
 * refs/opencommander/checkpoints/<id>. It never touches HEAD, the branch, the
 * index or the stash, so it is invisible to the user's normal git workflow.
 * Rollback restores the working tree (and the index) to the snapshot and first
 * takes an automatic "pre-rollback" checkpoint so the rollback is undoable.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, ExecResult, newId, ToolError } from './util.js';

const REF_PREFIX = 'refs/opencommander/checkpoints/';
const IDENT = {
    GIT_AUTHOR_NAME: 'OpenCommander', GIT_AUTHOR_EMAIL: 'opencommander@localhost',
    GIT_COMMITTER_NAME: 'OpenCommander', GIT_COMMITTER_EMAIL: 'opencommander@localhost',
};

export async function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; maxBytes?: number } = {}): Promise<ExecResult> {
    return execFile('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], {
        cwd, env: { LC_ALL: 'C', ...(opts.env || {}) }, timeoutMs: opts.timeoutMs ?? 60000, input: opts.input, maxBytes: opts.maxBytes,
    });
}

async function gitOk(cwd: string, args: string[], opts: Parameters<typeof git>[2] = {}): Promise<string> {
    const r = await git(cwd, args, opts);
    if (r.code !== 0) throw new ToolError(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 800)}`);
    return r.stdout;
}

export async function repoRoot(p: string): Promise<string | null> {
    let dir = p;
    try { if (!fs.statSync(p).isDirectory()) dir = path.dirname(p); } catch { return null; }
    const r = await git(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 15000 });
    if (r.code !== 0) return null;
    return path.resolve(r.stdout.trim());
}

export async function requireRepo(p: string): Promise<string> {
    const root = await repoRoot(p);
    if (!root) throw new ToolError(`Not a git repository: ${p}`, { hint: 'Run `git init` (job_start) first, or pass a path inside a git repo.' });
    return root;
}

async function hasHead(root: string): Promise<boolean> {
    return (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
}

export interface StatusSummary {
    root: string;
    branch?: string;
    upstream?: string;
    ahead?: number;
    behind?: number;
    detached?: boolean;
    clean: boolean;
    staged: string[];
    unstaged: string[];
    untracked: string[];
    conflicted: string[];
    counts: { staged: number; unstaged: number; untracked: number; conflicted: number };
    recent_commits: string[];
    stash_count?: number;
    checkpoints?: number;
    in_progress?: string;
}

export async function status(root: string, maxFiles = 150): Promise<StatusSummary> {
    const out = await gitOk(root, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=normal']);
    const parts = out.split('\0').filter(Boolean);
    const s: StatusSummary = { root, clean: true, staged: [], unstaged: [], untracked: [], conflicted: [], counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, recent_commits: [] };
    for (let i = 0; i < parts.length; i++) {
        const e = parts[i];
        if (e.startsWith('## ')) {
            const h = e.slice(3);
            const m = /^(?:No commits yet on )?([^.\s]+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(h);
            if (h.startsWith('HEAD (no branch)')) s.detached = true;
            if (m) {
                s.branch = m[1];
                s.upstream = m[2];
                const a = /ahead (\d+)/.exec(m[3] || ''); const b = /behind (\d+)/.exec(m[3] || '');
                if (a) s.ahead = +a[1]; if (b) s.behind = +b[1];
            }
            continue;
        }
        const x = e[0]; const y = e[1]; let file = e.slice(3);
        if (x === 'R' || x === 'C') { const orig = parts[++i]; file = `${orig} -> ${file}`; }
        const push = (arr: string[], key: keyof StatusSummary['counts'], v: string) => { s.counts[key]++; if (arr.length < maxFiles) arr.push(v); };
        if (x === '?' && y === '?') push(s.untracked, 'untracked', file);
        else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) push(s.conflicted, 'conflicted', file);
        else {
            if (x !== ' ' && x !== '!') push(s.staged, 'staged', `${x} ${file}`);
            if (y !== ' ' && y !== '!') push(s.unstaged, 'unstaged', `${y} ${file}`);
        }
    }
    s.clean = !s.counts.staged && !s.counts.unstaged && !s.counts.untracked && !s.counts.conflicted;
    if (await hasHead(root)) {
        const log = await git(root, ['log', '-n', '5', '--pretty=format:%h %ad %an: %s', '--date=short']);
        s.recent_commits = log.stdout.split('\n').filter(Boolean);
    }
    const stash = await git(root, ['stash', 'list']);
    s.stash_count = stash.stdout.split('\n').filter(Boolean).length;
    const refs = await git(root, ['for-each-ref', '--format=%(refname)', REF_PREFIX]);
    s.checkpoints = refs.stdout.split('\n').filter(Boolean).length;
    const gitDir = (await git(root, ['rev-parse', '--git-dir'])).stdout.trim();
    const gd = path.resolve(root, gitDir);
    for (const [f, name] of [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase/am'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']]) {
        if (fs.existsSync(path.join(gd, f))) { s.in_progress = name; break; }
    }
    return s;
}

export async function diff(root: string, o: { staged?: boolean; base?: string; files?: string[]; stat_only?: boolean; context?: number; offset_lines?: number; max_lines?: number }) {
    const args = ['diff', '--no-ext-diff'];
    if (o.staged) args.push('--cached');
    if (o.base) args.push(o.base);
    const statArgs = [...args, '--stat=200', '--summary'];
    const patchArgs = [...args, `-U${Math.min(Math.max(o.context ?? 3, 0), 20)}`];
    const tail = o.files?.length ? ['--', ...o.files] : [];
    const stat = await gitOk(root, [...statArgs, ...tail]);
    const numstat = await gitOk(root, [...args, '--numstat', ...tail]);
    let added = 0; let removed = 0; let files = 0;
    for (const l of numstat.split('\n').filter(Boolean)) {
        const [a, r] = l.split('\t');
        files++; added += Number(a) || 0; removed += Number(r) || 0;
    }
    const untracked = o.staged || o.base ? [] : (await gitOk(root, ['ls-files', '--others', '--exclude-standard', ...tail])).split('\n').filter(Boolean);
    const res: Record<string, unknown> = {
        root, mode: o.base ? `vs ${o.base}` : o.staged ? 'staged' : 'unstaged (working tree vs index)',
        files_changed: files, insertions: added, deletions: removed,
        stat: stat.trim(),
        untracked_files: untracked.slice(0, 100),
        untracked_count: untracked.length,
    };
    if (!o.stat_only) {
        const patch = await gitOk(root, [...patchArgs, ...tail], { maxBytes: 32 * 1024 * 1024 });
        const lines = patch.split('\n');
        const off = Math.max(0, o.offset_lines ?? 0);
        const max = Math.min(Math.max(o.max_lines ?? 400, 20), 3000);
        res.total_lines = lines.length;
        res.offset_lines = off;
        res.patch = lines.slice(off, off + max).join('\n');
        if (off + max < lines.length) res.next_offset_lines = off + max;
    }
    return res;
}

// ------------------------------------------------------------------ checkpoints

export interface CheckpointInfo { id: string; commit: string; created_at: string; message: string; head?: string; index_tree?: string; files?: number }

async function snapshotTree(root: string): Promise<{ tree: string; indexTree: string; head: string | null }> {
    const head = (await hasHead(root)) ? (await gitOk(root, ['rev-parse', 'HEAD'])).trim() : null;
    const indexTree = (await gitOk(root, ['write-tree'])).trim(); // real index, unchanged
    const tmpIndex = path.join(os.tmpdir(), `oc-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
        if (head) await gitOk(root, ['read-tree', head], { env });
        await gitOk(root, ['add', '-A', '--', '.'], { env, timeoutMs: 180000 });
        const tree = (await gitOk(root, ['write-tree'], { env })).trim();
        return { tree, indexTree, head };
    } finally {
        try { fs.rmSync(tmpIndex, { force: true }); } catch { /* ignore */ }
        try { fs.rmSync(`${tmpIndex}.lock`, { force: true }); } catch { /* ignore */ }
    }
}

export async function createCheckpoint(root: string, message: string): Promise<CheckpointInfo> {
    const { tree, indexTree, head } = await snapshotTree(root);
    const id = newId('ckpt');
    const created = new Date().toISOString();
    const body = `opencommander checkpoint: ${message || '(no message)'}\n\nOC-Id: ${id}\nOC-Created: ${created}\nOC-Head: ${head || ''}\nOC-Index-Tree: ${indexTree}\n`;
    const args = ['commit-tree', tree, '-F', '-'];
    if (head) args.splice(2, 0, '-p', head);
    const commit = (await gitOk(root, args, { env: IDENT, input: body })).trim();
    await gitOk(root, ['update-ref', REF_PREFIX + id, commit]);
    let files: number | undefined;
    if (head) {
        const ns = await git(root, ['diff', '--name-only', head, commit]);
        files = ns.stdout.split('\n').filter(Boolean).length;
    }
    return { id, commit, created_at: created, message, head: head || undefined, index_tree: indexTree, files };
}

export async function listCheckpoints(root: string, limit = 30): Promise<CheckpointInfo[]> {
    const out = await gitOk(root, ['for-each-ref', '--sort=-creatordate', `--count=${limit}`, '--format=%(refname)%00%(objectname)%00%(contents)%00%01', REF_PREFIX]);
    const res: CheckpointInfo[] = [];
    for (const rec of out.split('\u0001').map(s => s.replace(/^\n/, '')).filter(Boolean)) {
        const [ref, commit, contents] = rec.split('\0');
        if (!ref) continue;
        const kv = (k: string) => new RegExp(`^${k}: (.*)$`, 'm').exec(contents || '')?.[1]?.trim();
        res.push({
            id: ref.slice(REF_PREFIX.length),
            commit,
            created_at: kv('OC-Created') || '',
            message: ((contents || '').split('\n')[0] || '').replace(/^opencommander checkpoint: /, ''),
            head: kv('OC-Head') || undefined,
            index_tree: kv('OC-Index-Tree') || undefined,
        });
    }
    return res.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function rollback(root: string, id: string, paths?: string[]) {
    const all = await listCheckpoints(root, 1000);
    const cp = all.find(c => c.id === id);
    if (!cp) throw new ToolError(`Checkpoint not found: ${id}`, { available: all.slice(0, 10).map(c => `${c.id} ${c.created_at} ${c.message}`) });

    const safety = await createCheckpoint(root, `auto: before rollback to ${id}`);
    const pathspec = paths?.length ? paths : ['.'];

    // 1) Files that exist now but not in the checkpoint were created afterwards -> remove.
    const current = (await gitOk(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspec])).split('\0').filter(Boolean);
    const inCkpt = new Set((await gitOk(root, ['ls-tree', '-r', '-z', '--name-only', cp.commit, '--', ...pathspec])).split('\0').filter(Boolean));
    const removed: string[] = [];
    for (const f of current) {
        if (!inCkpt.has(f)) {
            try { fs.rmSync(path.join(root, f), { force: true }); removed.push(f); } catch { /* ignore */ }
        }
    }
    // 2) Restore content of every file in the checkpoint.
    if (inCkpt.size) await gitOk(root, ['checkout', cp.commit, '--', ...pathspec], { timeoutMs: 180000 });
    // 3) Restore the index exactly as it was when the checkpoint was taken (full rollback only).
    if (!paths?.length && cp.index_tree) {
        await gitOk(root, ['read-tree', cp.index_tree]);
    } else if (paths?.length) {
        // checkout <commit> -- paths staged the files; put the index back for those paths.
        const hasH = await hasHead(root);
        if (hasH) await git(root, ['reset', '-q', 'HEAD', '--', ...paths]);
    }
    const after = await status(root, 60);
    return {
        rolled_back_to: { id: cp.id, created_at: cp.created_at, message: cp.message },
        undo_checkpoint: safety.id,
        removed_files: removed.slice(0, 100),
        removed_count: removed.length,
        status_after: { clean: after.clean, counts: after.counts },
        note: `To undo this rollback call git_rollback with checkpoint_id "${safety.id}".`,
    };
}

export async function deleteCheckpoint(root: string, id: string) {
    await gitOk(root, ['update-ref', '-d', REF_PREFIX + id]);
    return { deleted: id };
}

/** Apply a unified diff. check_only => validate only. */
export async function applyPatch(root: string, patch: string, o: { check_only?: boolean; three_way?: boolean; reverse?: boolean }) {
    const normalized = patch.replace(/\r\n/g, '\n').replace(/\n?$/, '\n');
    const base = ['apply', '--recount', '--whitespace=nowarn', '-v'];
    if (o.reverse) base.push('-R');
    const check = await git(root, [...base, '--check', '-'], { input: normalized });
    const stat = await git(root, ['apply', '--recount', '--stat', '--summary', ...(o.reverse ? ['-R'] : []), '-'], { input: normalized });
    if (o.check_only) {
        return { ok: check.code === 0, stat: stat.stdout.trim(), details: (check.stderr || check.stdout).trim().slice(0, 4000) };
    }
    if (check.code !== 0) {
        if (o.three_way !== false) {
            const r3 = await git(root, [...base, '--3way', '-'], { input: normalized });
            return {
                ok: r3.code === 0,
                method: '3way',
                stat: stat.stdout.trim(),
                details: (r3.stderr || r3.stdout).trim().slice(0, 4000),
                note: r3.code === 0 ? 'Applied with 3-way merge.' : 'Patch does not apply. Re-read the current file content and regenerate the patch (or use edit_block).',
            };
        }
        return { ok: false, stat: stat.stdout.trim(), details: (check.stderr || check.stdout).trim().slice(0, 4000) };
    }
    const r = await git(root, [...base, '-'], { input: normalized });
    return { ok: r.code === 0, method: 'apply', stat: stat.stdout.trim(), details: (r.stderr || r.stdout).trim().slice(0, 4000) };
}
