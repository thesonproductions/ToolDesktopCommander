/**
 * Shared bridge to the upstream Desktop Commander core (tool handlers).
 *
 * Both the HTTP transport (http.ts) and the hub agent (agent.ts) need a fresh
 * MCP Server that shares the same tool handlers (which already route through the
 * OpenCommander guard). This loads the core once, silences its stdout logging,
 * and hands out servers that reuse its request handlers.
 */
import fs from 'fs';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { dirs, ensureConfigFile, ensureDirs } from './config.js';
import { OC_VERSION } from './tools.js';
import { SHORT_INSTRUCTIONS, WORKFLOW_GUIDE } from './instructions.js';

let baseHandlers: Map<string, unknown> | null = null;

/** Redirect the core's console/logging away from stdout (would corrupt protocols). */
export function redirectConsole(): void {
    ensureDirs();
    const logFile = path.join(dirs.root, 'server.log');
    const write = (lvl: string, args: unknown[]) => {
        const line = args.map(a => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
        if (/\[(FEEDBACK|ONBOARDING) DEBUG\]/.test(line)) return;
        try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${lvl} ${line}\n`); } catch { /* ignore */ }
    };
    console.log = (...a: unknown[]) => write('log', a);
    console.info = (...a: unknown[]) => write('info', a);
    console.debug = (...a: unknown[]) => write('debug', a);
    console.warn = (...a: unknown[]) => write('warn', a);
    (global as any).mcpTransport = {
        sendLog: (level: string, message: string, data?: unknown) => write(level, [message, ...(data ? [data] : [])]),
        enableNotifications: () => { /* no-op */ },
        configureForClient: () => { /* no-op */ },
    };
}

/** Load the upstream core once and cache its request handlers. */
export async function loadCore(): Promise<Map<string, unknown>> {
    if (baseHandlers) return baseHandlers;
    ensureConfigFile();
    redirectConsole();
    const core = await import('../server.js');
    const { configManager } = await import('../config-manager.js');
    try { await configManager.loadConfig(); } catch { /* in-memory config */ }
    baseHandlers = (core.server as any)._requestHandlers as Map<string, unknown>;
    return baseHandlers;
}

/** Build a fresh MCP Server that reuses the core's tool handlers. */
export function makeCoreServer(handlers: Map<string, unknown>): Server {
    const s = new Server(
        { name: 'opencommander', version: OC_VERSION },
        { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} }, instructions: `${SHORT_INSTRUCTIONS}\n\n${WORKFLOW_GUIDE}` },
    );
    const target: Map<string, unknown> = (s as any)._requestHandlers;
    for (const [method, handler] of handlers) target.set(method, handler);
    return s;
}
