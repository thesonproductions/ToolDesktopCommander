/**
 * OpenCommander configuration + state directories.
 *
 * Everything OpenCommander persists lives under ~/.opencommander (override with
 * OPENCOMMANDER_HOME):
 *
 *   config.json      user-editable settings (security profile, roots, http port…)
 *   token            bearer token for the HTTP endpoint (created on first run)
 *   jobs/<id>/       persistent background jobs (spec, state, logs, artifacts)
 *   keys/            idempotency index (request_key -> job id)
 *   approvals/       pending / decided approval requests
 *   tasks/           task-state notes used to resume work after a disconnect
 *   audit/           JSONL audit log, one file per day
 *   dc/              config of the embedded Desktop Commander core
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

export type SecurityProfile = 'developer' | 'strict' | 'open';

export interface OpenCommanderConfig {
    security: {
        profile: SecurityProfile;
        /** Directories tools may touch. Empty = anywhere (protected paths still apply). */
        allowed_roots: string[];
        /** Paths that are never readable/writable through tools. `~` is expanded. */
        protected_paths: string[];
        /** Extra regexes (case-insensitive) that force APPROVAL_REQUIRED for shell commands. */
        extra_approval_patterns: string[];
        /** Extra regexes that are always denied. */
        extra_deny_patterns: string[];
        /** strict profile: commands matching one of these regexes run without approval. */
        strict_allow_patterns: string[];
        /** Minutes an approval stays valid after the user approves it. */
        approval_ttl_minutes: number;
        /** Mask secrets (API keys, private keys, tokens) in tool output. */
        mask_secrets: boolean;
    };
    http: {
        host: string;
        port: number;
        /** Local-only approvals dashboard (never exposed through the tunnel). */
        admin_port: number;
        /** Hard cap for one MCP tool call before we answer "still running, use jobs". */
        tool_call_timeout_seconds: number;
        /** Upstream start_process/interact timeouts are clamped to this in HTTP mode. */
        max_sync_wait_ms: number;
    };
    jobs: {
        /** Shell used for job commands: auto | powershell | pwsh | cmd | bash | sh */
        shell: string;
        /** Identical command+cwd started within this window is deduplicated (no request_key needed). */
        auto_dedupe_seconds: number;
        /** Default max seconds a *_run tool waits synchronously before returning a job id. */
        default_wait_seconds: number;
        /** Delete finished jobs older than this many days (job_cleanup / startup). */
        retention_days: number;
    };
    output: {
        /** Tool results larger than this are truncated (the full data stays on disk). */
        max_tool_output_chars: number;
    };
    /** Upstream tools hidden from the model (noise for ChatGPT). */
    hidden_tools: string[];
    /** Send upstream Desktop Commander telemetry. Off by default. */
    telemetry: boolean;
    /** This computer's name in a multi-machine hub (e.g. "PC", "Laptop"). Defaults to the hostname. */
    machine_name: string;
    /** Hub (Cloudflare Worker) settings for `opencommander agent`. */
    hub: {
        /** Hub base URL, e.g. https://opencommander-hub.<you>.workers.dev */
        url: string;
        /** Shared AGENT_KEY secret configured on the hub. Env OPENCOMMANDER_AGENT_KEY wins. */
        agent_key: string;
    };
}

export const DEFAULT_CONFIG: OpenCommanderConfig = {
    security: {
        profile: 'developer',
        allowed_roots: [],
        protected_paths: [
            '~/.ssh',
            '~/.aws',
            '~/.azure',
            '~/.gnupg',
            '~/.kube',
            '~/.docker/config.json',
            '~/.config/gcloud',
            '~/.config/gh/hosts.yml',
            '~/.git-credentials',
            '~/.netrc',
            '~/.npmrc',
            '~/.pypirc',
            '~/.opencommander',
            '~/AppData/Local/Google/Chrome/User Data',
            '~/AppData/Local/Microsoft/Edge/User Data',
            '~/AppData/Roaming/Mozilla/Firefox',
            '~/AppData/Roaming/Microsoft/Credentials',
            '~/AppData/Local/Microsoft/Credentials',
            '~/Library/Application Support/Google/Chrome',
            '~/Library/Keychains',
            '~/.config/google-chrome',
            '~/.mozilla',
        ],
        extra_approval_patterns: [],
        extra_deny_patterns: [],
        strict_allow_patterns: [
            '^\\s*git\\s+(status|diff|log|show|branch|rev-parse|ls-files)\\b',
            '^\\s*(ls|dir|pwd|cat|type|echo|where|which|rg|grep|findstr)\\b',
            '^\\s*(pytest|python -m pytest|npm (run )?test|npx (jest|vitest)|go test|cargo test|ruff|eslint|tsc)\\b',
        ],
        approval_ttl_minutes: 15,
        mask_secrets: true,
    },
    http: {
        host: '127.0.0.1',
        port: 7800,
        admin_port: 7801,
        tool_call_timeout_seconds: 90,
        max_sync_wait_ms: 45000,
    },
    jobs: {
        shell: 'auto',
        auto_dedupe_seconds: 20,
        default_wait_seconds: 40,
        retention_days: 14,
    },
    output: {
        max_tool_output_chars: 60000,
    },
    hidden_tools: [
        'give_feedback_to_desktop_commander',
        'get_prompts',
        'get_usage_stats',
        'track_ui_event',
    ],
    telemetry: false,
    machine_name: '',
    hub: { url: '', agent_key: '' },
};

/** This machine's name in a hub, resolved from config/env/hostname. */
export function machineName(): string {
    const raw = (process.env.OPENCOMMANDER_MACHINE || getConfig().machine_name || os.hostname() || 'machine').trim();
    return raw.replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 40) || 'machine';
}

export function ocHome(): string {
    return process.env.OPENCOMMANDER_HOME
        ? path.resolve(process.env.OPENCOMMANDER_HOME)
        : path.join(os.homedir(), '.opencommander');
}

export const dirs = {
    get root() { return ocHome(); },
    get jobs() { return path.join(ocHome(), 'jobs'); },
    get keys() { return path.join(ocHome(), 'keys'); },
    get approvals() { return path.join(ocHome(), 'approvals'); },
    get tasks() { return path.join(ocHome(), 'tasks'); },
    get audit() { return path.join(ocHome(), 'audit'); },
    get dc() { return path.join(ocHome(), 'dc'); },
};

export function ensureDirs(): void {
    for (const d of [dirs.root, dirs.jobs, dirs.keys, dirs.approvals, dirs.tasks, dirs.audit, dirs.dc]) {
        fs.mkdirSync(d, { recursive: true });
    }
}

function isObj(v: unknown): v is Record<string, any> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge<T>(base: T, over: unknown): T {
    if (!isObj(base) || !isObj(over)) return (over === undefined ? base : over) as T;
    const out: Record<string, any> = { ...(base as any) };
    for (const [k, v] of Object.entries(over)) {
        out[k] = isObj(out[k]) && isObj(v) ? deepMerge(out[k], v) : v;
    }
    return out as T;
}

let cached: { mtime: number; cfg: OpenCommanderConfig } | null = null;

export function configPath(): string {
    return path.join(ocHome(), 'config.json');
}

/** Load config (cached, reloaded automatically when the file changes). */
export function getConfig(): OpenCommanderConfig {
    const p = configPath();
    let mtime = -1;
    try { mtime = fs.statSync(p).mtimeMs; } catch { /* missing */ }
    if (cached && cached.mtime === mtime) return cached.cfg;
    let user: unknown = {};
    if (mtime >= 0) {
        try {
            user = JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (e) {
            process.stderr.write(`[opencommander] invalid ${p}: ${(e as Error).message} — using defaults\n`);
        }
    }
    const cfg = deepMerge(DEFAULT_CONFIG, user);
    cached = { mtime, cfg };
    return cfg;
}

/** Read the raw user config.json (without defaults merged). */
export function readRawConfig(): Record<string, any> {
    try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}

/** Set a dotted key (e.g. "hub.url") in config.json, coercing simple types. */
export function setConfigKey(dotted: string, rawValue: string): { key: string; value: unknown } {
    ensureDirs();
    ensureConfigFile();
    const obj = readRawConfig();
    let value: unknown = rawValue;
    if (rawValue === 'true') value = true;
    else if (rawValue === 'false') value = false;
    else if (rawValue !== '' && !Number.isNaN(Number(rawValue)) && /^-?\d+(\.\d+)?$/.test(rawValue)) value = Number(rawValue);
    else if (rawValue.startsWith('[') || rawValue.startsWith('{')) { try { value = JSON.parse(rawValue); } catch { /* keep string */ } }
    const parts = dotted.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    fs.writeFileSync(configPath(), JSON.stringify(obj, null, 2) + '\n', 'utf8');
    cached = null;
    return { key: dotted, value };
}

/** Write a default config.json if none exists yet. */
export function ensureConfigFile(): string {
    ensureDirs();
    const p = configPath();
    if (!fs.existsSync(p)) {
        fs.writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    }
    return p;
}

/** Bearer token for the HTTP endpoint. Env OPENCOMMANDER_TOKEN wins. */
export function getOrCreateToken(): string {
    if (process.env.OPENCOMMANDER_TOKEN) return process.env.OPENCOMMANDER_TOKEN;
    ensureDirs();
    const p = path.join(ocHome(), 'token');
    try {
        const t = fs.readFileSync(p, 'utf8').trim();
        if (t.length >= 16) return t;
    } catch { /* create */ }
    const t = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(p, t + '\n', { encoding: 'utf8', mode: 0o600 });
    return t;
}

export function rotateToken(): string {
    ensureDirs();
    const p = path.join(ocHome(), 'token');
    const t = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(p, t + '\n', { encoding: 'utf8', mode: 0o600 });
    return t;
}

export function expandHome(p: string): string {
    if (p === '~') return os.homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
    return p;
}
