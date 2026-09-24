/**
 * Human approval flow for risky operations.
 *
 * 1. A risky tool call returns APPROVAL_REQUIRED with an approval_id.
 * 2. The human approves OUTSIDE ChatGPT: the local dashboard
 *    (http://127.0.0.1:<admin_port>/approvals, never tunnelled) or the CLI
 *    `opencommander approve <id>`.
 * 3. The model repeats the exact same call with `approval_id`. The approval is
 *    bound to a fingerprint of tool+arguments, single-use and time-limited.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { dirs, ensureDirs, getConfig } from '../config.js';
import { newId, readJson, writeJsonAtomic } from '../util.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'used' | 'expired';

export interface Approval {
    id: string;
    tool: string;
    fingerprint: string;
    summary: string;
    reasons: string[];
    status: ApprovalStatus;
    created_at: string;
    decided_at?: string;
    decided_by?: string;
    used_at?: string;
}

const PENDING_TTL_MS = 60 * 60 * 1000;

function stable(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') {
        return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(',')}}`;
    }
    return JSON.stringify(v);
}

export function fingerprint(tool: string, args: Record<string, unknown> | undefined): string {
    const clean: Record<string, unknown> = { ...(args || {}) };
    delete clean.approval_id;
    delete clean.wait_seconds; // how long to wait does not change what runs
    return crypto.createHash('sha256').update(tool + '\0' + stable(clean)).digest('hex');
}

function file(id: string): string {
    if (!/^apr_[a-z0-9]+$/i.test(id)) throw new Error(`invalid approval id ${id}`);
    return path.join(dirs.approvals, `${id}.json`);
}

function expireIfNeeded(a: Approval): Approval {
    const now = Date.now();
    const ttl = getConfig().security.approval_ttl_minutes * 60000;
    if (a.status === 'pending' && now - Date.parse(a.created_at) > PENDING_TTL_MS) a.status = 'expired';
    if (a.status === 'approved' && a.decided_at && now - Date.parse(a.decided_at) > ttl) a.status = 'expired';
    return a;
}

export function getApproval(id: string): Approval | null {
    try {
        const a = readJson<Approval>(file(id));
        return a ? expireIfNeeded(a) : null;
    } catch { return null; }
}

export function listApprovals(status?: ApprovalStatus | 'all', limit = 50): Approval[] {
    ensureDirs();
    let names: string[] = [];
    try { names = fs.readdirSync(dirs.approvals).filter(n => n.endsWith('.json')).sort().reverse(); } catch { /* none */ }
    const out: Approval[] = [];
    for (const n of names) {
        const a = readJson<Approval>(path.join(dirs.approvals, n));
        if (!a) continue;
        expireIfNeeded(a);
        if (status && status !== 'all' && a.status !== status) continue;
        out.push(a);
        if (out.length >= limit) break;
    }
    return out;
}

export function requestApproval(tool: string, args: Record<string, unknown> | undefined, reasons: string[], summary: string): Approval {
    ensureDirs();
    const fp = fingerprint(tool, args);
    // Reuse an identical pending request instead of spamming the dashboard.
    const existing = listApprovals('pending', 200).find(a => a.fingerprint === fp);
    if (existing) return existing;
    const a: Approval = {
        id: newId('apr'),
        tool,
        fingerprint: fp,
        summary: summary.slice(0, 4000),
        reasons,
        status: 'pending',
        created_at: new Date().toISOString(),
    };
    writeJsonAtomic(file(a.id), a);
    return a;
}

export function decide(id: string, decision: 'approved' | 'denied', by = 'local-user'): Approval {
    const a = getApproval(id);
    if (!a) throw new Error(`approval ${id} not found`);
    if (a.status !== 'pending') throw new Error(`approval ${id} is ${a.status}, not pending`);
    a.status = decision;
    a.decided_at = new Date().toISOString();
    a.decided_by = by;
    writeJsonAtomic(file(id), a);
    return a;
}

/** Validate + consume an approval for this exact call. */
export function consume(id: string, tool: string, args: Record<string, unknown> | undefined): { ok: boolean; status: string; message: string } {
    const a = getApproval(id);
    if (!a) return { ok: false, status: 'not_found', message: `approval ${id} not found` };
    if (a.fingerprint !== fingerprint(tool, args)) {
        return { ok: false, status: 'mismatch', message: 'approval_id belongs to a different tool call. Repeat the original call with identical arguments, or request a new approval.' };
    }
    if (a.status === 'pending') return { ok: false, status: 'pending', message: 'Still waiting for the user to approve.' };
    if (a.status !== 'approved') return { ok: false, status: a.status, message: `approval is ${a.status}` };
    a.status = 'used';
    a.used_at = new Date().toISOString();
    writeJsonAtomic(file(id), a);
    return { ok: true, status: 'used', message: 'approved' };
}
