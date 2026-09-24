import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { DIST, ROOT } from './helpers.mjs';

const { parseTestOutput, parseDiagnostics, errorExcerpt } = await import(path.join(DIST, 'opencommander', 'parsers.js'));
const fx = (n) => fs.readFileSync(path.join(ROOT, 'test', 'opencommander', 'fixtures', n), 'utf8');

test('pytest: counts, failing tests, file:line, raise location', () => {
    const r = parseTestOutput(fx('pytest.txt'));
    assert.equal(r.framework, 'pytest');
    assert.equal(r.passed, 2);
    assert.equal(r.failed, 2);
    assert.equal(r.failures.length, 2);
    const f = r.failures.find(x => x.test.endsWith('test_add_wrong'));
    assert.equal(f.file, 'tests/test_calc.py');
    assert.equal(f.line, 7);
    assert.match(f.message, /math is broken/);
    const z = r.failures.find(x => x.test.endsWith('test_div_zero'));
    assert.equal(z.raised_at, 'calc.py:5');
});

test('pytest -q summary without banners', () => {
    const r = parseTestOutput(fx('pytest-q.txt'), 'pytest');
    assert.equal(r.framework, 'pytest');
    assert.equal(r.failed, 2);
    assert.equal(r.passed, 2);
});

test('node:test TAP', () => {
    const r = parseTestOutput(fx('node-tap.txt'));
    assert.equal(r.framework, 'tap');
    assert.equal(r.passed, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.failures[0].test, 'mul broken');
    assert.equal(r.failures[0].line, 5);
    assert.match(r.failures[0].message, /strictly equal/);
});

test('jest', () => {
    const r = parseTestOutput(fx('jest.txt'));
    assert.equal(r.framework, 'jest');
    assert.equal(r.failed, 1);
    assert.equal(r.passed, 225);
    assert.equal(r.total, 226);
    assert.equal(r.duration_seconds, 10.8);
    assert.equal(r.failures[0].file, 'src/reviewer/service.test.ts');
    assert.equal(r.failures[0].line, 82);
    assert.match(r.failures[0].test, /validates schema/);
});

test('vitest', () => {
    const r = parseTestOutput(fx('vitest.txt'));
    assert.equal(r.framework, 'vitest');
    assert.equal(r.failed, 1);
    assert.equal(r.passed, 40);
    assert.equal(r.failures[0].file, 'src/math.test.ts');
    assert.equal(r.failures[0].line, 12);
});

test('go test', () => {
    const r = parseTestOutput(fx('go.txt'));
    assert.equal(r.framework, 'go');
    assert.equal(r.failed, 1);
    assert.equal(r.failures[0].test, 'TestDiv');
    assert.equal(r.failures[0].file, 'calc_test.go');
    assert.equal(r.failures[0].line, 14);
});

test('cargo test', () => {
    const r = parseTestOutput(fx('cargo.txt'));
    assert.equal(r.framework, 'cargo');
    assert.equal(r.passed, 2);
    assert.equal(r.failed, 1);
    assert.equal(r.failures[0].file, 'src/lib.rs');
    assert.equal(r.failures[0].line, 21);
});

test('diagnostics: tsc, ruff, mypy, eslint, rustc', () => {
    const d = parseDiagnostics(fx('diag.txt'));
    const files = new Set(d.items.map(i => i.file));
    assert.ok(files.has('src/app.ts'));
    assert.ok(files.has('pkg/models.py'));
    assert.ok(files.has('pkg/service.py'));
    assert.ok(files.has('/home/u/proj/src/index.js'));
    assert.ok(files.has('src/main.rs'));
    const ts = d.items.find(i => i.code === 'TS2322');
    assert.equal(ts.line, 12);
    assert.equal(d.warnings, 1);
    assert.ok(d.errors >= 7);
});

test('unparseable output falls back to an excerpt', () => {
    const r = parseTestOutput('something weird happened\nFatal error: boom\n');
    assert.equal(r.parsed, false);
    assert.match(errorExcerpt('a\nb\nFatal error: boom\nc'), /boom/);
});
