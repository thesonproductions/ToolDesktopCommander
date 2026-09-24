#!/usr/bin/env node
/**
 * One-command deploy of the OpenCommander hub to Cloudflare Workers.
 *
 *   node deploy.mjs
 *
 * - Runs `wrangler deploy`.
 * - Generates MCP_TOKEN / AGENT_KEY / ADMIN_KEY if you don't have them and
 *   uploads them as Worker secrets.
 * - Prints exactly what to paste into ChatGPT and into each machine's config.
 *
 * Requires: a free Cloudflare account. `npx wrangler login` once first.
 */
import { spawnSync } from 'child_process';
import crypto from 'crypto';

const token = () => crypto.randomBytes(24).toString('base64url');
const run = (args, opts = {}) => spawnSync('npx', ['wrangler', ...args], { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
const capture = (args) => spawnSync('npx', ['wrangler', ...args], { encoding: 'utf8', shell: process.platform === 'win32' });

function putSecret(name, value) {
    const r = spawnSync('npx', ['wrangler', 'secret', 'put', name], { input: value + '\n', encoding: 'utf8', shell: process.platform === 'win32' });
    if (r.status !== 0) { process.stderr.write(r.stderr || ''); throw new Error(`failed to set secret ${name}`); }
}

function existingSecrets() {
    const r = capture(['secret', 'list']);
    try { return new Set(JSON.parse(r.stdout).map(s => s.name)); } catch { return new Set(); }
}

console.log('OpenCommander hub — deploy to Cloudflare Workers\n');

// 1) deploy the Worker (creates it if new)
const dep = run(['deploy']);
if (dep.status !== 0) {
    console.error('\nDeploy failed. If you are not logged in, run:  npx wrangler login');
    process.exit(1);
}

// 2) ensure secrets
const have = existingSecrets();
const secrets = {};
const force = process.argv.includes('--rotate');
for (const name of ['MCP_TOKEN', 'AGENT_KEY', 'ADMIN_KEY']) {
    if (have.has(name) && !force) { console.log(`secret ${name}: kept (use --rotate to regenerate)`); continue; }
    const v = token();
    putSecret(name, v);
    secrets[name] = v;
    console.log(`secret ${name}: set`);
}

// 3) find the workers.dev URL
let url = process.env.HUB_URL || '';
const info = capture(['deployments', 'list']);
const m = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(info.stdout || '');
if (m) url = m[0];

console.log('\n──────────────────────────────────────────────────────────────');
console.log('Hub deployed.', url ? `URL: ${url}` : '(open the Cloudflare dashboard to see the *.workers.dev URL)');
if (Object.keys(secrets).length) {
    console.log('\nSAVE THESE NOW (shown once):');
    for (const [k, v] of Object.entries(secrets)) console.log(`  ${k} = ${v}`);
} else {
    console.log('\nSecrets already existed; re-run with --rotate to regenerate them.');
}
const U = url || 'https://<your-hub>.workers.dev';
console.log(`
Connect ChatGPT (once):
  Developer mode -> Create plugin -> URL:
    ${U}/mcp/${secrets.MCP_TOKEN || '<MCP_TOKEN>'}
  Authentication: None

On EACH computer (PC, Laptop):
  opencommander config set hub.url ${U}
  opencommander config set hub.agent_key ${secrets.AGENT_KEY || '<AGENT_KEY>'}
  opencommander config set machine_name PC        # or Laptop
  opencommander agent                             # keep running (autostart script available)

Approvals dashboard (share nobody): ${U}/admin   (key = ADMIN_KEY)
──────────────────────────────────────────────────────────────`);
