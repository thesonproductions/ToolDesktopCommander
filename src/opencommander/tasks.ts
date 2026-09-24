/**
 * Task state = durable working memory for long tasks.
 *
 * ChatGPT conversations get cut off (timeouts, context limits, reloads). The
 * model saves goal/plan/progress/next steps here as it works; after an
 * interruption a fresh prompt ("continue task X") restores the full picture in
 * one call instead of re-discovering everything.
 */
import fs from 'fs';
import path from 'path';
import { dirs, ensureDirs } from './config.js';
import { readJson, ToolError, writeJsonAtomic } from './util.js';

export interface TaskState {
    task_id: string;
    title?: string;
    repo?: string;
    goal?: string;
    status: 'active' | 'blocked' | 'done' | 'abandoned';
    plan?: string[];
    done?: string[];
    next_steps?: string[];
    notes?: string;
    related_jobs?: string[];
    checkpoints?: string[];
    created_at: string;
    updated_at: string;
    history: Array<{ at: string; summary: string }>;
}

function slug(id: string): string {
    const s = id.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    if (!s) throw new ToolError('task_id must contain letters or digits');
    return s;
}

const fileOf = (id: string) => path.join(dirs.tasks, `${slug(id)}.json`);

export function getTask(id: string): TaskState | null {
    return readJson<TaskState>(fileOf(id));
}

export function saveTask(input: Partial<TaskState> & { task_id: string; progress_note?: string; append_done?: string[] }): TaskState {
    ensureDirs();
    const now = new Date().toISOString();
    const prev = getTask(input.task_id);
    const t: TaskState = prev || {
        task_id: slug(input.task_id), status: 'active', created_at: now, updated_at: now, history: [],
    };
    for (const k of ['title', 'repo', 'goal', 'status', 'plan', 'next_steps', 'notes', 'done'] as const) {
        if (input[k] !== undefined) (t as any)[k] = input[k];
    }
    if (input.append_done?.length) t.done = [...(t.done || []), ...input.append_done];
    if (input.related_jobs?.length) t.related_jobs = [...new Set([...(t.related_jobs || []), ...input.related_jobs])].slice(-50);
    if (input.checkpoints?.length) t.checkpoints = [...new Set([...(t.checkpoints || []), ...input.checkpoints])].slice(-50);
    t.updated_at = now;
    if (input.progress_note) t.history.push({ at: now, summary: input.progress_note.slice(0, 2000) });
    if (t.history.length > 200) t.history = t.history.slice(-200);
    writeJsonAtomic(fileOf(t.task_id), t);
    return t;
}

export function listTasks(status?: string, limit = 30): Array<Pick<TaskState, 'task_id' | 'title' | 'status' | 'repo' | 'updated_at'> & { next_step?: string }> {
    ensureDirs();
    let files: string[] = [];
    try { files = fs.readdirSync(dirs.tasks).filter(f => f.endsWith('.json')); } catch { return []; }
    const all = files.map(f => readJson<TaskState>(path.join(dirs.tasks, f))).filter((t): t is TaskState => !!t);
    return all
        .filter(t => !status || status === 'all' || t.status === status)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, limit)
        .map(t => ({ task_id: t.task_id, title: t.title, status: t.status, repo: t.repo, updated_at: t.updated_at, next_step: t.next_steps?.[0] }));
}
