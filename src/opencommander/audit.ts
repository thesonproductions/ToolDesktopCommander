/** Append-only JSONL audit log: ~/.opencommander/audit/YYYY-MM-DD.jsonl */
import fs from 'fs';
import path from 'path';
import { dirs, ensureDirs } from './config.js';
import { maskSecrets } from './security/mask.js';

export interface AuditEntry {
    ts: string;
    tool: string;
    args: unknown;
    decision: string;
    reasons?: string[];
    approval_id?: string;
    is_error?: boolean;
    duration_ms?: number;
    transport?: string;
    result_preview?: string;
}

function shrink(v: unknown, depth = 0): unknown {
    if (typeof v === 'string') {
        const m = maskSecrets(v).text;
        return m.length > 1500 ? `${m.slice(0, 1500)}…(${m.length} chars)` : m;
    }
    if (Array.isArray(v)) return depth > 3 ? `[array ${v.length}]` : v.slice(0, 50).map(x => shrink(x, depth + 1));
    if (v && typeof v === 'object') {
        if (depth > 3) return '{…}';
        const o: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) o[k] = shrink(x, depth + 1);
        return o;
    }
    return v;
}

export function audit(e: Omit<AuditEntry, 'ts'>): void {
    try {
        ensureDirs();
        const ts = new Date().toISOString();
        const f = path.join(dirs.audit, `${ts.slice(0, 10)}.jsonl`);
        fs.appendFileSync(f, JSON.stringify({ ts, ...e, args: shrink(e.args) }) + '\n');
    } catch { /* never break a tool call because of audit */ }
}

export function readAudit(limit = 50, tool?: string): AuditEntry[] {
    ensureDirs();
    let files: string[] = [];
    try { files = fs.readdirSync(dirs.audit).filter(f => f.endsWith('.jsonl')).sort().reverse(); } catch { return []; }
    const out: AuditEntry[] = [];
    for (const f of files) {
        const lines = fs.readFileSync(path.join(dirs.audit, f), 'utf8').split('\n').filter(Boolean).reverse();
        for (const l of lines) {
            try {
                const e = JSON.parse(l) as AuditEntry;
                if (tool && e.tool !== tool) continue;
                out.push(e);
                if (out.length >= limit) return out;
            } catch { /* skip */ }
        }
    }
    return out;
}
