#!/usr/bin/env node
/**
 * opencommander <command>
 *
 *   serve [--port N] [--host H] [--admin-port N] [--no-admin]   HTTP MCP server for ChatGPT
 *   stdio                                                       stdio MCP server (Claude Desktop, Cursor, …)
 *   init                                                        create config + token, print setup steps
 *   token [--rotate] [--show]                                   print/rotate the bearer token
 *   approvals | approve <id> | deny <id>                        human approval flow
 *   jobs [status] | job <id> | logs <id> [--tail N] | cancel <id>
 *   doctor                                                      environment checks
 */
import '../bootstrap.js';
import './env-bootstrap.js';
import net from 'net';
import { spawnSync } from 'child_process';
import { configPath, dirs, ensureConfigFile, getConfig, getOrCreateToken, rotateToken } from './config.js';
import { decide, listApprovals } from './security/approvals.js';
import { cancelJob, listJobs, readLogs, requireJob, summarize } from './jobs/manager.js';
import { hasBinary, IS_WIN } from './util.js';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const out = (v: unknown) => process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n');

function help() {
    out(`OpenCommander — your own Desktop-Commander-style MCP server (no tool quotas, persistent jobs)

Usage: opencommander <command>

  serve [--port 7800] [--host 127.0.0.1] [--admin-port 7801] [--no-admin]
                 Start the HTTP MCP endpoint for ChatGPT (put a tunnel in front of it)
  stdio          Start as a stdio MCP server (Claude Desktop / Cursor / VS Code)
  init           Create config + token and print the ChatGPT connection steps
  token          Print the token and connector URLs   (--rotate to create a new one)
  approvals      List pending approvals
  approve <id>   Approve a pending risky action        deny <id>   Deny it
  jobs [status]  List jobs (active|finished|failed|…)  job <id>    Show one job
  logs <id> [--tail 200]                               cancel <id> Cancel a job
  doctor         Check node/git/ripgrep/shell/ports/config

State: ${dirs.root}   Config: ${configPath()}`);
}

function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise(r => {
        const s = net.createServer();
        s.once('error', () => r(false));
        s.once('listening', () => s.close(() => r(true)));
        s.listen(port, host);
    });
}

async function main() {
    // OpenCommander product mode (vs. running upstream dist/index.js directly):
    // hides upstream marketing tools, disables onboarding/feedback injection,
    // isolates the embedded Desktop Commander config under ~/.opencommander/dc.
    process.env.OPENCOMMANDER_CLI = '1';
    process.env.OPENCOMMANDER_DC_CONFIG_DIR ||= dirs.dc;
    switch (cmd) {
        case 'serve': {
            const { serve } = await import('./http.js');
            await serve({
                host: opt('host'),
                port: opt('port') ? Number(opt('port')) : undefined,
                adminPort: opt('admin-port') ? Number(opt('admin-port')) : undefined,
                noAdmin: flag('no-admin'),
            });
            return;
        }
        case 'stdio': {
            process.argv.splice(2, 1); // upstream index.ts inspects argv[2]
            await import('../index.js');
            return;
        }
        case 'init': {
            const p = ensureConfigFile();
            const t = getOrCreateToken();
            const c = getConfig();
            out(`Config : ${p}
Token  : ${t}

Next steps
 1. Edit the config if you want: security.allowed_roots (e.g. ["D:\\\\Project"]), security.profile.
 2. Start the server:            opencommander serve
 3. Expose it over HTTPS, e.g.:  cloudflared tunnel --url http://127.0.0.1:${c.http.port}
 4. ChatGPT → Settings → Apps & Connectors → Advanced → Developer mode → Create connector
      URL:  https://<your-tunnel-host>/mcp/${t}
      Auth: No authentication (the secret is in the URL)  — or use a client that sends
            "Authorization: Bearer ${t}" to https://<host>/mcp
 5. Approvals dashboard (local only): http://127.0.0.1:${c.http.admin_port}/`);
            return;
        }
        case 'token': {
            const t = flag('rotate') ? rotateToken() : getOrCreateToken();
            const c = getConfig();
            out({ token: t, local_url: `http://127.0.0.1:${c.http.port}/mcp/${t}`, header: `Authorization: Bearer ${t}`, note: flag('rotate') ? 'Token rotated — update the ChatGPT connector URL and restart the server.' : undefined });
            return;
        }
        case 'approvals':
            out(listApprovals((argv[1] as any) || 'pending', 50).map(a => ({ id: a.id, status: a.status, tool: a.tool, reasons: a.reasons, summary: a.summary.slice(0, 300), created_at: a.created_at })));
            return;
        case 'approve':
        case 'deny': {
            const id = argv[1];
            if (!id) { out('usage: opencommander approve <approval_id>'); process.exitCode = 2; return; }
            const a = decide(id, cmd === 'approve' ? 'approved' : 'denied', 'cli');
            out(`${a.id}: ${a.status}\n${a.summary}`);
            return;
        }
        case 'jobs':
            out(listJobs({ status: argv[1], limit: 50 }).map(summarize));
            return;
        case 'job':
            out(summarize(requireJob(argv[1])));
            return;
        case 'logs': {
            const r: any = await readLogs(requireJob(argv[1]), { tail_lines: Number(opt('tail') || 200), max_bytes: 100000 });
            out(r.text);
            return;
        }
        case 'cancel':
            out(await cancelJob(argv[1]));
            return;
        case 'doctor': {
            const c = getConfig();
            const checks: Record<string, unknown> = {};
            checks.node = process.version;
            checks.node_ok = Number(process.versions.node.split('.')[0]) >= 18;
            checks.platform = `${process.platform} ${process.arch}`;
            const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
            checks.git = git.status === 0 ? git.stdout.trim() : 'NOT FOUND (repo_* / git_* tools need git)';
            try {
                const { getRipgrepPath } = await import('../utils/ripgrep-resolver.js');
                checks.ripgrep = await getRipgrepPath();
            } catch (e) { checks.ripgrep = `NOT FOUND: ${(e as Error).message}`; }
            checks.shells = Object.fromEntries(['powershell', 'pwsh', 'bash', 'cmd'].map(s => [s, hasBinary(IS_WIN && s !== 'cmd' && s !== 'bash' ? `${s}.exe` : s)]));
            checks.state_dir = dirs.root;
            checks.config = configPath();
            checks.profile = c.security.profile;
            checks.allowed_roots = c.security.allowed_roots;
            checks[`port_${c.http.port}_free`] = await portFree(c.http.port, c.http.host);
            checks[`admin_port_${c.http.admin_port}_free`] = await portFree(c.http.admin_port);
            checks.cloudflared = hasBinary(IS_WIN ? 'cloudflared.exe' : 'cloudflared');
            checks.ngrok = hasBinary(IS_WIN ? 'ngrok.exe' : 'ngrok');
            out(checks);
            return;
        }
        default:
            help();
    }
}

main().catch(e => {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exit(1);
});
