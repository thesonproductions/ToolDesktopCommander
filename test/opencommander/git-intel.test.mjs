import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { DIST, freshHome, git, makeRepo } from './helpers.mjs';

freshHome();
const G = await import(path.join(DIST, 'opencommander', 'git.js'));
const I = await import(path.join(DIST, 'opencommander', 'intel.js'));
const D = await import(path.join(DIST, 'opencommander', 'detect.js'));

const FILES = {
    'pyproject.toml': '[project]\nname = "demo"\n\n[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\n',
    'demo/__init__.py': '',
    'demo/models.py': 'from dataclasses import dataclass\n\n\n@dataclass\nclass ReviewerResult:\n    ok: bool\n    findings: list\n\n\ndef make_result(ok):\n    return ReviewerResult(ok=ok, findings=[])\n',
    'demo/service.py': 'from .models import ReviewerResult, make_result\n\n\nclass ReviewerService:\n    def run(self, data):\n        r = make_result(True)\n        return r\n\n    def validate(self, data) -> ReviewerResult:\n        return make_result(bool(data))\n',
    'tests/test_models.py': 'from demo.models import ReviewerResult, make_result\n\n\ndef test_make():\n    assert make_result(True).ok\n',
    'web/src/api.ts': "import { helper } from './util';\nexport interface ApiResult { ok: boolean }\nexport async function fetchThing(id: string): Promise<ApiResult> {\n  return { ok: helper(id) };\n}\n",
    'web/src/util.ts': 'export const helper = (s: string) => s.length > 0;\n',
    'web/src/api.test.ts': "import { fetchThing } from './api';\ntest('x', async () => { expect((await fetchThing('a')).ok).toBe(true); });\n",
    '.gitignore': 'node_modules/\n*.log\n',
    'README.md': '# Demo\n\nA demo repo.\n',
};

test('status reports branch, changes and untracked files', async () => {
    const repo = await makeRepo(FILES);
    fs.appendFileSync(path.join(repo, 'demo/models.py'), '\n# changed\n');
    fs.writeFileSync(path.join(repo, 'new_file.py'), 'x = 1\n');
    const s = await G.status(repo);
    assert.equal(s.branch, 'main');
    assert.equal(s.clean, false);
    assert.deepEqual(s.unstaged, ['M demo/models.py']);
    assert.deepEqual(s.untracked, ['new_file.py']);
    assert.equal(s.recent_commits.length, 1);
    const d = await G.diff(repo, {});
    assert.equal(d.files_changed, 1);
    assert.match(d.patch, /\+# changed/);
    assert.deepEqual(d.untracked_files, ['new_file.py']);
});

test('checkpoint + rollback restores edits, deletions and removes new files; rollback is undoable', async () => {
    const repo = await makeRepo(FILES);
    // pre-existing uncommitted work that must be preserved by the checkpoint
    fs.writeFileSync(path.join(repo, 'wip.txt'), 'work in progress\n');
    await git(repo, 'add', 'wip.txt'); // staged
    const headBefore = (await git(repo, 'rev-parse', 'HEAD')).trim();
    const cp = await G.createCheckpoint(repo, 'before agent edits');
    assert.match(cp.id, /^ckpt_/);
    assert.equal((await git(repo, 'rev-parse', 'HEAD')).trim(), headBefore, 'HEAD untouched');
    assert.equal((await git(repo, 'stash', 'list')).trim(), '', 'stash untouched');

    // agent makes a mess
    fs.writeFileSync(path.join(repo, 'demo/models.py'), 'BROKEN\n');
    fs.rmSync(path.join(repo, 'demo/service.py'));
    fs.writeFileSync(path.join(repo, 'demo/new_module.py'), 'print(1)\n');
    fs.writeFileSync(path.join(repo, 'debug.log'), 'ignored file must survive\n');

    const r = await G.rollback(repo, cp.id);
    assert.equal(fs.readFileSync(path.join(repo, 'demo/models.py'), 'utf8'), FILES['demo/models.py']);
    assert.ok(fs.existsSync(path.join(repo, 'demo/service.py')));
    assert.ok(!fs.existsSync(path.join(repo, 'demo/new_module.py')));
    assert.ok(fs.existsSync(path.join(repo, 'debug.log')), 'gitignored files untouched');
    assert.equal(fs.readFileSync(path.join(repo, 'wip.txt'), 'utf8'), 'work in progress\n');
    const st = await G.status(repo);
    assert.deepEqual(st.staged, ['A wip.txt'], 'index restored exactly');
    assert.ok(r.undo_checkpoint);

    // undo the rollback
    await G.rollback(repo, r.undo_checkpoint);
    assert.equal(fs.readFileSync(path.join(repo, 'demo/models.py'), 'utf8'), 'BROKEN\n');
    assert.ok(fs.existsSync(path.join(repo, 'demo/new_module.py')));

    const list = await G.listCheckpoints(repo);
    assert.ok(list.length >= 3);
    assert.ok(list.some(c => c.message === 'before agent edits'));
});

test('patch preview / apply / 3-way fallback', async () => {
    const repo = await makeRepo(FILES);
    const patch = [
        'diff --git a/web/src/util.ts b/web/src/util.ts',
        '--- a/web/src/util.ts',
        '+++ b/web/src/util.ts',
        '@@ -1 +1,2 @@',
        ' export const helper = (s: string) => s.length > 0;',
        '+export const twice = (n: number) => n * 2;',
        '',
    ].join('\n');
    const pv = await G.applyPatch(repo, patch, { check_only: true });
    assert.equal(pv.ok, true);
    assert.match(pv.stat, /util\.ts/);
    const ap = await G.applyPatch(repo, patch, {});
    assert.equal(ap.ok, true);
    assert.match(fs.readFileSync(path.join(repo, 'web/src/util.ts'), 'utf8'), /twice/);
    const bad = await G.applyPatch(repo, patch.replace('s.length > 0', 's.length > 99'), { three_way: false });
    assert.equal(bad.ok, false);
});

test('project detection (python + node in subdir)', async () => {
    const repo = await makeRepo(FILES);
    const info = D.detectProject(repo, 'bash');
    assert.ok(info.types.includes('python'));
    assert.match(info.test.command, /-m pytest/);
    assert.equal(info.test.parser, 'pytest');
    assert.match(info.lint.command, /ruff check/);
});

test('repo_overview', async () => {
    const repo = await makeRepo(FILES);
    const o = await I.overview(repo);
    assert.equal(o.files, Object.keys(FILES).length);
    assert.ok(o.languages.some(l => l.startsWith('Python')));
    assert.ok(o.languages.some(l => l.startsWith('TypeScript')));
    assert.equal(o.test_files, 2);
    assert.equal(o.manifests['pyproject.toml'].name, 'demo');
    assert.match(o.readme_head, /A demo repo/);
    assert.equal(o.git.branch, 'main');
});

test('repo_find_symbol: definitions + references (py + ts)', async () => {
    const repo = await makeRepo(FILES);
    const r = await I.findSymbol(repo, 'ReviewerResult');
    assert.deepEqual(r.definitions.map(d => `${d.file}:${d.line}:${d.kind}`), ['demo/models.py:5:class']);
    assert.ok(r.references_total >= 4);
    assert.ok(r.test_references.includes('tests/test_models.py'));
    const t = await I.findSymbol(repo, 'fetchThing');
    assert.equal(t.definitions[0].file, 'web/src/api.ts');
    assert.equal(t.definitions[0].kind, 'function');
    const m = await I.findSymbol(repo, 'ReviewerService.validate');
    assert.equal(m.definitions[0].file, 'demo/service.py');
});

test('repo_outline', async () => {
    const repo = await makeRepo(FILES);
    const o = I.outline(path.join(repo, 'demo/service.py'));
    assert.deepEqual(o.items.map(i => `${i.kind}:${i.name}:${i.line}`), ['class:ReviewerService:4', 'method:run:5', 'method:validate:9']);
    const t = I.outline(path.join(repo, 'web/src/api.ts'));
    assert.deepEqual(t.items.map(i => `${i.kind}:${i.name}`), ['interface:ApiResult', 'function:fetchThing']);
});

test('repo_related: imports, importers and tests', async () => {
    const repo = await makeRepo(FILES);
    const r = await I.related(path.join(repo, 'demo/models.py'));
    assert.ok(r.imported_by.includes('demo/service.py'));
    assert.ok(r.tests.includes('tests/test_models.py'));
    const t = await I.related(path.join(repo, 'web/src/api.ts'));
    assert.deepEqual(t.imports_local, ['web/src/util.ts']);
    assert.ok(t.tests.includes('web/src/api.test.ts'));
    const back = await I.related(path.join(repo, 'web/src/api.test.ts'));
    assert.ok(back.sources_under_test.includes('web/src/api.ts'));
});

test('repo_search + read_ranges', async () => {
    const repo = await makeRepo(FILES);
    const s = await I.search(repo, 'make_result', { context: 0 });
    assert.equal(s.files, 3);
    const rr = I.readRanges([{ path: path.join(repo, 'demo/service.py'), start_line: 4, end_line: 6 }, { path: path.join(repo, 'nope.txt') }]);
    assert.match(rr[0].content, /^\s+4\| class ReviewerService:/);
    assert.equal(rr[0].end_line, 6);
    assert.ok(rr[1].error);
});
