import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

export const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------- files

/** Atomic JSON write (tmp + rename, with retries for Windows EPERM/EBUSY). */
export function writeJsonAtomic(file: string, data: unknown): void {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    for (let i = 0; ; i++) {
        try {
            fs.renameSync(tmp, file);
            return;
        } catch (e: any) {
            if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) {
                try { fs.unlinkSync(tmp); } catch { /* ignore */ }
                throw e;
            }
            sleepSync(15 * (i + 1));
        }
    }
}

export function readJson<T = any>(file: string): T | null {
    for (let i = 0; i < 5; i++) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
        } catch (e: any) {
            if (e?.code === 'ENOENT') return null;
            // partially written / locked: retry briefly
            sleepSync(10 * (i + 1));
        }
    }
    return null;
}

export function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Read a byte range of a file as utf8. */
export function readRange(file: string, start: number, length: number): string {
    let fd: number | null = null;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        if (start >= size || length <= 0) return '';
        const len = Math.min(length, size - start);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        return buf.toString('utf8');
    } catch {
        return '';
    } finally {
        if (fd !== null) fs.closeSync(fd);
    }
}

export function fileSize(file: string): number {
    try { return fs.statSync(file).size; } catch { return 0; }
}

/** Last `maxLines` lines (bounded by maxBytes) of a file. */
export function tailFile(file: string, maxLines: number, maxBytes: number): { text: string; start: number; size: number } {
    const size = fileSize(file);
    const start = Math.max(0, size - maxBytes);
    let text = readRange(file, start, size - start);
    if (start > 0) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : text;
    }
    const lines = text.split('\n');
    if (lines.length > maxLines + 1) {
        text = lines.slice(lines.length - maxLines - 1).join('\n');
    }
    return { text, start: size - Buffer.byteLength(text, 'utf8'), size };
}

// ---------------------------------------------------------------- text

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(s: string): string {
    return s.replace(ANSI_RE, '').replace(/\r(?!\n)/g, '\n');
}

export function truncateMiddle(s: string, max: number): string {
    if (s.length <= max) return s;
    const head = Math.floor(max * 0.4);
    const tail = max - head - 80;
    return `${s.slice(0, head)}\n…[${s.length - head - tail} chars truncated]…\n${s.slice(s.length - tail)}`;
}

export function truncateEnd(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

// ---------------------------------------------------------------- MCP results

export interface ToolResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
    [k: string]: unknown;
}

/** Structured JSON result (compact, model-friendly). */
export function ok(data: unknown): ToolResult {
    return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] };
}

export function fail(message: string, extra?: Record<string, unknown>): ToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message, ...(extra || {}) }, null, 1) }],
        isError: true,
    };
}

export class ToolError extends Error {
    constructor(message: string, public extra?: Record<string, unknown>) { super(message); }
}

// ---------------------------------------------------------------- processes

export function isPidAlive(pid: number | undefined | null): boolean {
    if (!pid || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return e?.code === 'EPERM';
    }
}

/** Kill a whole process tree. Unix: the child was started as a group leader. */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!pid) return;
    if (IS_WIN) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return;
    }
    try { process.kill(-pid, signal); } catch { /* not a group leader */ }
    try { process.kill(pid, signal); } catch { /* already gone */ }
}

export interface ExecResult {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
}

/** Run a program (no shell) and capture output. Used for short git/rg calls. */
export function execFile(cmd: string, args: string[], opts: {
    cwd?: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv; maxBytes?: number;
} = {}): Promise<ExecResult> {
    const started = Date.now();
    const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(cmd, args, {
                cwd: opts.cwd,
                env: { ...process.env, ...(opts.env || {}), GIT_TERMINAL_PROMPT: '0' },
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (e: any) {
            resolve({ code: -1, stdout: '', stderr: String(e?.message || e), timedOut: false, durationMs: 0 });
            return;
        }
        const out: Buffer[] = []; const err: Buffer[] = [];
        let outLen = 0; let errLen = 0; let timedOut = false;
        child.stdout.on('data', (d: Buffer) => { if (outLen < maxBytes) { out.push(d); outLen += d.length; } });
        child.stderr.on('data', (d: Buffer) => { if (errLen < maxBytes) { err.push(d); errLen += d.length; } });
        const timer = opts.timeoutMs ? setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, opts.timeoutMs) : null;
        child.on('error', (e: any) => {
            if (timer) clearTimeout(timer);
            resolve({ code: -1, stdout: '', stderr: String(e?.message || e), timedOut, durationMs: Date.now() - started });
        });
        child.on('close', (code: number | null) => {
            if (timer) clearTimeout(timer);
            resolve({
                code,
                stdout: Buffer.concat(out).toString('utf8'),
                stderr: Buffer.concat(err).toString('utf8'),
                timedOut,
                durationMs: Date.now() - started,
            });
        });
        if (opts.input !== undefined) child.stdin.end(opts.input); else child.stdin.end();
    });
}

// ---------------------------------------------------------------- shells

export interface ShellSpec { file: string; args: string[]; name: string; verbatim?: boolean }

let whichCache = new Map<string, boolean>();
export function hasBinary(bin: string): boolean {
    if (whichCache.has(bin)) return whichCache.get(bin)!;
    const r = spawnSync(IS_WIN ? 'where' : 'which', [bin], { windowsHide: true, stdio: 'ignore' });
    const found = r.status === 0;
    whichCache.set(bin, found);
    return found;
}

/**
 * Build argv to run `command` through a shell.
 * PowerShell gets -EncodedCommand (no quoting problems) and a wrapper that makes
 * the exit code reflect native command failures.
 */
export function shellCommand(command: string, shell: string = 'auto'): ShellSpec {
    let s = (shell || 'auto').toLowerCase();
    if (s === 'auto') s = IS_WIN ? 'powershell' : (hasBinary('bash') ? 'bash' : 'sh');
    if (s === 'powershell' || s === 'pwsh' || s.endsWith('powershell.exe') || s.endsWith('pwsh.exe')) {
        const exe = s === 'pwsh' || s.endsWith('pwsh.exe') ? 'pwsh' : 'powershell.exe';
        const script = [
            '$ProgressPreference = "SilentlyContinue"',
            'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
            '$global:LASTEXITCODE = $null',
            command,
            '$__ocOk = $?',
            'if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) { exit $global:LASTEXITCODE }',
            'if (-not $__ocOk) { exit 1 }',
            'exit 0',
        ].join('\n');
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        return { file: exe, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], name: exe };
    }
    if (s === 'cmd' || s.endsWith('cmd.exe')) {
        return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], name: 'cmd', verbatim: true };
    }
    if (s === 'bash' || s.endsWith('/bash') || s.endsWith('bash.exe')) {
        return { file: s === 'bash' ? 'bash' : shell, args: ['-c', command], name: 'bash' };
    }
    return { file: s === 'sh' ? 'sh' : shell, args: ['-c', command], name: s };
}

export function newId(prefix: string): string {
    const t = Date.now().toString(36);
    const r = Math.random().toString(36).slice(2, 7);
    return `${prefix}_${t}${r}`;
}

export function normalizeForCompare(p: string): string {
    let r = path.resolve(p);
    if (IS_WIN) r = r.toLowerCase();
    return r.replace(/[\\/]+$/, '');
}

export function isWithin(child: string, parent: string): boolean {
    const c = normalizeForCompare(child);
    const p = normalizeForCompare(parent);
    if (c === p) return true;
    const rel = path.relative(p, c);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function asInt(v: unknown, def: number, min?: number, max?: number): number {
    let n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) n = def;
    n = Math.floor(n);
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    return n;
}
