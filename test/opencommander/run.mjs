// Portable runner: node test/opencommander/run.mjs [filter]
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.mjs') && (!filter || f.includes(filter))).map(f => path.join(dir, f));
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
