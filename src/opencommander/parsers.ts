/**
 * Turn raw tool output (tests, linters, compilers) into small structured
 * summaries so the model reads 1 KB of JSON instead of 5 MB of terminal log.
 */
import { stripAnsi } from './util.js';

export interface Failure { test?: string; file?: string; line?: number; message?: string }
export interface Diagnostic { file: string; line?: number; col?: number; severity: string; code?: string; message: string }

export interface TestSummary {
    framework: string;
    passed?: number;
    failed?: number;
    errors?: number;
    skipped?: number;
    total?: number;
    duration_seconds?: number;
    failures: Failure[];
    parsed: boolean;
}

const MAX_ITEMS = 30;
const num = (s: string | undefined) => (s === undefined ? undefined : Number(s));
const clip = (s: string | undefined, n = 300) => (s && s.length > n ? s.slice(0, n) + '…' : s);

function lastMatch(text: string, re: RegExp): RegExpExecArray | null {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null; let last: RegExpExecArray | null = null;
    while ((m = g.exec(text))) { last = m; if (m[0] === '') g.lastIndex++; }
    return last;
}

// ------------------------------------------------------------------ pytest
function parsePytest(t: string): TestSummary | null {
    let sum = lastMatch(t, /^=+ (.*?(?:passed|failed|error|errors|skipped|no tests ran|deselected|xfailed|xpassed).*?) in ([\d.]+)s(?: \([^)]*\))? =+\s*$/m);
    // `pytest -q` prints the summary without the ==== banner
    if (!sum && /\[\s*\d+%\]|(^|\n)(FAILED|ERROR|PASSED) \S+::/.test(t)) {
        sum = lastMatch(t, /^((?:\d+ (?:passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?)(?:, )?)+) in ([\d.]+)s/m);
    }
    if (!sum) return null;
    const body = sum[1];
    const get = (k: string) => { const m = new RegExp(`(\\d+) ${k}\\b`).exec(body); return m ? Number(m[1]) : 0; };
    const s: TestSummary = {
        framework: 'pytest',
        passed: get('passed'), failed: get('failed'), errors: get('errors?'), skipped: get('skipped'),
        duration_seconds: Number(sum[2]), failures: [], parsed: true,
    };
    s.total = (s.passed || 0) + (s.failed || 0) + (s.errors || 0) + (s.skipped || 0);
    // locations from failure sections: "____ test_name ____" … "path.py:82: AssertionError"
    const loc = new Map<string, { file: string; line: number; err?: string; raised_at?: string }>();
    const secRe = /^_{3,} (?:ERROR (?:at \w+ of |collecting ))?(.+?) _{3,}\s*$/gm;
    const secs: Array<{ name: string; start: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = secRe.exec(t))) secs.push({ name: m[1].trim(), start: m.index });
    for (let i = 0; i < secs.length; i++) {
        const chunk = t.slice(secs[i].start, i + 1 < secs.length ? secs[i + 1].start : undefined);
        const first = /^([^\s:][^:\n]*\.py):(\d+): (\w+)/m.exec(chunk);
        const last = lastMatch(chunk, /^([^\s:][^:\n]*\.py):(\d+): (\w+)/m);
        const errLine = lastMatch(chunk, /^E\s+(\S.*)$/m);
        if (first) {
            loc.set(secs[i].name, {
                file: first[1], line: Number(first[2]),
                err: errLine?.[1] || (last && last[3] !== 'in' ? last[3] : undefined),
                raised_at: last && (last[1] !== first[1] || last[2] !== first[2]) ? `${last[1]}:${last[2]}` : undefined,
            });
        }
    }
    const lineRe = /^(FAILED|ERROR) (\S+?)(?: - (.*))?$/gm;
    while ((m = lineRe.exec(t)) && s.failures.length < MAX_ITEMS) {
        const id = m[2];
        const parts = id.split('::');
        const shortName = parts[parts.length - 1];
        const l = loc.get(shortName) || loc.get(parts.slice(1).join('.')) || [...loc.entries()].find(([k]) => k.endsWith(shortName))?.[1];
        const f: Failure & { raised_at?: string } = {
            test: id,
            file: l?.file || parts[0],
            line: l?.line,
            message: clip(m[3] || l?.err || (m[1] === 'ERROR' ? 'error' : undefined)),
        };
        if (l?.raised_at) f.raised_at = l.raised_at;
        s.failures.push(f);
    }
    return s;
}

// ------------------------------------------------------------------ unittest
function parseUnittest(t: string): TestSummary | null {
    const ran = lastMatch(t, /^Ran (\d+) tests? in ([\d.]+)s/m);
    if (!ran) return null;
    const total = Number(ran[1]);
    const res = lastMatch(t, /^(OK|FAILED)(?: \(([^)]*)\))?\s*$/m);
    const kv = (k: string) => { const m = res?.[2] ? new RegExp(`${k}=(\\d+)`).exec(res[2]) : null; return m ? Number(m[1]) : 0; };
    const failed = kv('failures'); const errors = kv('errors'); const skipped = kv('skipped');
    const s: TestSummary = { framework: 'unittest', total, failed, errors, skipped, passed: total - failed - errors - skipped, duration_seconds: Number(ran[2]), failures: [], parsed: true };
    const re = /^(FAIL|ERROR): (\S+) \(([^)]+)\)[\s\S]*?(?:File "([^"]+)", line (\d+)[\s\S]*?)?^(\w+(?:Error|Exception)[^\n]*)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) && s.failures.length < MAX_ITEMS) {
        s.failures.push({ test: `${m[3]}.${m[2]}`, file: m[4], line: num(m[5]), message: clip(m[6]) });
    }
    return s;
}

// ------------------------------------------------------------------ jest / vitest
function parseJest(t: string): TestSummary | null {
    const tests = lastMatch(t, /^Tests:\s+(.*?)(\d+) total/m);
    if (!tests) return null;
    const body = tests[1];
    const get = (k: string) => { const m = new RegExp(`(\\d+) ${k}`).exec(body); return m ? Number(m[1]) : 0; };
    const time = lastMatch(t, /^Time:\s+([\d.]+)\s*(ms|s)/m);
    const s: TestSummary = {
        framework: 'jest', passed: get('passed'), failed: get('failed'), skipped: get('skipped') + get('todo'),
        total: Number(tests[2]), duration_seconds: time ? Number(time[1]) / (time[2] === 'ms' ? 1000 : 1) : undefined,
        failures: [], parsed: true,
    };
    const re = /^\s+● (.+?)\s*$([\s\S]*?)(?=^\s+● |^Test Suites:|$(?![\s\S]))/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) && s.failures.length < MAX_ITEMS) {
        if (/Console$/.test(m[1])) continue;
        const block = m[2];
        const msg = block.split('\n').map(x => x.trim()).find(x => x && !x.startsWith('at ') && !/^\d+ \|/.test(x) && !x.startsWith('>'));
        const at = /\(?([^\s()]+\.(?:[jt]sx?|mjs|cjs)):(\d+):\d+\)?/.exec(block);
        s.failures.push({ test: m[1].replace(/ › /g, ' > '), file: at?.[1], line: num(at?.[2]), message: clip(msg) });
    }
    return s;
}

function parseVitest(t: string): TestSummary | null {
    const tests = lastMatch(t, /^\s*Tests\s+(.*?)\((\d+)\)\s*$/m);
    if (!tests) return null;
    const body = tests[1];
    const get = (k: string) => { const m = new RegExp(`(\\d+) ${k}`).exec(body); return m ? Number(m[1]) : 0; };
    const dur = lastMatch(t, /^\s*Duration\s+([\d.]+)(ms|s)/m);
    const s: TestSummary = {
        framework: 'vitest', passed: get('passed'), failed: get('failed'), skipped: get('skipped') + get('todo'),
        total: Number(tests[2]), duration_seconds: dur ? Number(dur[1]) / (dur[2] === 'ms' ? 1000 : 1) : undefined,
        failures: [], parsed: true,
    };
    const re = /^\s*FAIL\s+(\S+) > (.+)$([\s\S]*?)(?=^\s*FAIL\s|^\s*⎯{3,}\s*$|$(?![\s\S]))/gm;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = re.exec(t)) && s.failures.length < MAX_ITEMS) {
        const key = m[1] + m[2];
        if (seen.has(key)) continue;
        seen.add(key);
        const block = m[3];
        const msg = block.split('\n').map(x => x.trim()).find(x => /Error|expected|assert/i.test(x));
        const at = /❯\s+(\S+?):(\d+):\d+/.exec(block);
        s.failures.push({ test: m[2].trim(), file: at?.[1] || m[1], line: num(at?.[2]), message: clip(msg) });
    }
    return s;
}

// ------------------------------------------------------------------ go
function parseGo(t: string): TestSummary | null {
    if (!/^ok\s+\S+\s+(\(cached\)|[\d.]+s)|^FAIL\t\S+|^\s*--- (PASS|FAIL|SKIP): /m.test(t)) return null;
    const pass = (t.match(/^\s*--- PASS:/gm) || []).length;
    const fail = (t.match(/^\s*--- FAIL:/gm) || []).length;
    const skip = (t.match(/^\s*--- SKIP:/gm) || []).length;
    const pkgOk = (t.match(/^ok\s+\S+/gm) || []).length;
    const pkgFail = (t.match(/^FAIL\s+\S+/gm) || []).length;
    const s: TestSummary = { framework: 'go', passed: pass, failed: fail || pkgFail, skipped: skip, total: pass + fail + skip, failures: [], parsed: true };
    (s as any).packages_ok = pkgOk;
    (s as any).packages_failed = pkgFail;
    const re = /^\s*--- FAIL: (\S+) \(([\d.]+)s\)\n((?:\s{4,}.*\n?)*)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) && s.failures.length < MAX_ITEMS) {
        let loc = /(\S+_test\.go):(\d+): (.*)/.exec(m[3]);
        if (!loc) {
            // -v output prints the messages before the --- FAIL line, inside the === RUN block
            const start = t.lastIndexOf(`=== RUN   ${m[1]}`, m.index);
            if (start >= 0) loc = /(\S+_test\.go):(\d+): (.*)/.exec(t.slice(start, m.index));
        }
        s.failures.push({ test: m[1], file: loc?.[1], line: num(loc?.[2]), message: clip(loc?.[3] || m[3].trim().split('\n')[0]) });
    }
    return s;
}

// ------------------------------------------------------------------ cargo
function parseCargo(t: string): TestSummary | null {
    const all = [...t.matchAll(/^test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored;.*?finished in ([\d.]+)s/gm)];
    if (!all.length) return null;
    const s: TestSummary = { framework: 'cargo', passed: 0, failed: 0, skipped: 0, duration_seconds: 0, failures: [], parsed: true };
    for (const m of all) {
        s.passed! += Number(m[2]); s.failed! += Number(m[3]); s.skipped! += Number(m[4]); s.duration_seconds! += Number(m[5]);
    }
    s.total = s.passed! + s.failed! + s.skipped!;
    const re = /^---- (\S+) stdout ----\n([\s\S]*?)(?=^---- |^failures:|^test result)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) && s.failures.length < MAX_ITEMS) {
        const p = /panicked at (?:'([^']*)', )?([^\s:]+):(\d+):\d+:?\n?(.*)?/.exec(m[2]);
        s.failures.push({ test: m[1], file: p?.[2], line: num(p?.[3]), message: clip(p?.[1] || p?.[4] || m[2].trim().split('\n')[0]) });
    }
    return s;
}

// ------------------------------------------------------------------ mocha / node:test / tap
function parseMochaTap(t: string): TestSummary | null {
    const passing = lastMatch(t, /^\s*(\d+) passing(?: \(([\d.]+)(ms|s)\))?/m);
    if (passing) {
        const failing = lastMatch(t, /^\s*(\d+) failing/m);
        const pending = lastMatch(t, /^\s*(\d+) pending/m);
        const s: TestSummary = {
            framework: 'mocha', passed: Number(passing[1]), failed: failing ? Number(failing[1]) : 0, skipped: pending ? Number(pending[1]) : 0,
            duration_seconds: passing[2] ? Number(passing[2]) / (passing[3] === 'ms' ? 1000 : 1) : undefined, failures: [], parsed: true,
        };
        s.total = s.passed! + s.failed! + s.skipped!;
        const re = /^\s+\d+\) (.+)\n([\s\S]*?)(?=^\s+\d+\) |$(?![\s\S]))/gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(t.slice(t.search(/^\s*\d+ failing/m)))) && s.failures.length < MAX_ITEMS) {
            const msg = m[2].split('\n').map(x => x.trim()).find(x => /Error|expected/i.test(x));
            const at = /\(([^\s()]+\.[cm]?[jt]sx?):(\d+):\d+\)/.exec(m[2]);
            s.failures.push({ test: m[1].trim(), file: at?.[1], line: num(at?.[2]), message: clip(msg) });
        }
        return s;
    }
    const tapPass = lastMatch(t, /^# pass\s+(\d+)/m);
    if (tapPass) {
        const tapFail = lastMatch(t, /^# fail\s+(\d+)/m);
        const skipped = lastMatch(t, /^# skipped\s+(\d+)/m);
        const dur = lastMatch(t, /^# duration_ms\s+([\d.]+)/m);
        const s: TestSummary = {
            framework: 'tap', passed: Number(tapPass[1]), failed: tapFail ? Number(tapFail[1]) : 0, skipped: skipped ? Number(skipped[1]) : 0,
            duration_seconds: dur ? Number(dur[1]) / 1000 : undefined, failures: [], parsed: true,
        };
        s.total = s.passed! + s.failed! + s.skipped!;
        const re = /^\s*not ok \d+ - (.+)$([\s\S]*?)(?=^\s*(?:not )?ok \d+ |^# |$(?![\s\S]))/gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(t)) && s.failures.length < MAX_ITEMS) {
            const loc = /location: '?([^'\n]+?):(\d+):\d+'?/.exec(m[2]);
            let err = /\berror: '?([^\n']*)/.exec(m[2])?.[1]?.trim();
            if (err === '|-' || err === '|' || err === '>-' || !err) {
                const after = m[2].split(/\berror: [|>]-?\n/)[1] || '';
                err = after.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 3).join(' ');
            }
            s.failures.push({ test: m[1].trim(), file: loc?.[1], line: num(loc?.[2]), message: clip(err) });
        }
        return s;
    }
    return null;
}

// ------------------------------------------------------------------ JVM / .NET
function parseJvmDotnet(t: string): TestSummary | null {
    const dn = lastMatch(t, /(Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+),\s+Total:\s+(\d+)(?:, Duration: ([\d.]+) (m?s))?/);
    if (dn) {
        const s: TestSummary = { framework: 'dotnet', failed: Number(dn[2]), passed: Number(dn[3]), skipped: Number(dn[4]), total: Number(dn[5]), failures: [], parsed: true };
        const re = /^\s*Failed (\S+) \[[^\]]*\]\s*\n\s*Error Message:\s*\n\s*(.+)/gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(t)) && s.failures.length < MAX_ITEMS) s.failures.push({ test: m[1], message: clip(m[2]) });
        return s;
    }
    const mv = [...t.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)(?!.*in )/g)];
    if (mv.length) {
        const m = mv[mv.length - 1];
        const s: TestSummary = { framework: 'maven', total: Number(m[1]), failed: Number(m[2]), errors: Number(m[3]), skipped: Number(m[4]), failures: [], parsed: true };
        s.passed = s.total! - s.failed! - s.errors! - s.skipped!;
        const re = /^\[ERROR\]\s+(\S+)\s+(?:Time elapsed.*<<< (?:FAILURE|ERROR)!|.*?:(\d+) (.+))$/gm;
        let x: RegExpExecArray | null;
        while ((x = re.exec(t)) && s.failures.length < MAX_ITEMS) s.failures.push({ test: x[1], line: num(x[2]), message: clip(x[3]) });
        return s;
    }
    const gr = lastMatch(t, /(\d+) tests? completed, (\d+) failed(?:, (\d+) skipped)?/);
    if (gr) {
        const s: TestSummary = { framework: 'gradle', total: Number(gr[1]), failed: Number(gr[2]), skipped: num(gr[3]) || 0, failures: [], parsed: true };
        s.passed = s.total! - s.failed! - (s.skipped || 0);
        const re = /^(\S+) > (.+) FAILED\n\s+(.+)/gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(t)) && s.failures.length < MAX_ITEMS) s.failures.push({ test: `${m[1]} > ${m[2]}`, message: clip(m[3]) });
        return s;
    }
    return null;
}

const TEST_PARSERS: Record<string, (t: string) => TestSummary | null> = {
    pytest: parsePytest,
    unittest: parseUnittest,
    jest: parseJest,
    vitest: parseVitest,
    go: parseGo,
    cargo: parseCargo,
    mocha: parseMochaTap,
    tap: parseMochaTap,
    jvm: parseJvmDotnet,
};

export function parseTestOutput(raw: string, hint?: string): TestSummary {
    const t = stripAnsi(raw);
    const order = hint && TEST_PARSERS[hint]
        ? [hint, ...Object.keys(TEST_PARSERS).filter(k => k !== hint)]
        : ['pytest', 'vitest', 'jest', 'cargo', 'mocha', 'go', 'jvm', 'unittest'];
    for (const k of order) {
        try {
            const r = TEST_PARSERS[k](t);
            if (r) return r;
        } catch { /* try next */ }
    }
    return { framework: hint || 'unknown', failures: [], parsed: false };
}

// ------------------------------------------------------------------ diagnostics (lint / compile)

export function parseDiagnostics(raw: string, limit = 60): { errors: number; warnings: number; items: Diagnostic[]; files_with_issues: number } {
    const t = stripAnsi(raw);
    const items: Diagnostic[] = [];
    const seen = new Set<string>();
    let errors = 0; let warnings = 0;
    const push = (d: Diagnostic) => {
        const key = `${d.file}:${d.line}:${d.col}:${d.message}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (/warn/i.test(d.severity)) warnings++; else errors++;
        if (items.length < limit) items.push({ ...d, message: clip(d.message, 240)! });
    };
    let m: RegExpExecArray | null;

    // TypeScript: src/a.ts(12,5): error TS2322: msg
    const tsc = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/gm;
    while ((m = tsc.exec(t))) push({ file: m[1].trim(), line: +m[2], col: +m[3], severity: m[4], code: m[5], message: m[6] });
    // tsc --pretty / generic: file:line:col - error TS1234: msg
    const tsc2 = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.+)$/gm;
    while ((m = tsc2.exec(t))) push({ file: m[1].trim(), line: +m[2], col: +m[3], severity: m[4], code: m[5], message: m[6] });
    // ruff / flake8 / pylint-parseable: file:line:col: CODE msg
    const ruff = /^([^\s:][^:\n]*\.(?:py|pyi)):(\d+):(\d+): ([A-Z]+\d+) (.+)$/gm;
    while ((m = ruff.exec(t))) push({ file: m[1], line: +m[2], col: +m[3], severity: 'error', code: m[4], message: m[5] });
    // mypy: file:line: error: msg  [code]
    const mypy = /^([^\s:][^:\n]*\.pyi?):(\d+)(?::(\d+))?: (error|warning|note): (.+?)(?:\s+\[([\w-]+)\])?$/gm;
    while ((m = mypy.exec(t))) if (m[4] !== 'note') push({ file: m[1], line: +m[2], col: num(m[3]), severity: m[4], code: m[6], message: m[5] });
    // gcc/clang/go vet/generic: file:line:col: error: msg
    const gcc = /^([^\s:][^:\n]*\.\w+):(\d+):(\d+): (fatal error|error|warning): (.+)$/gm;
    while ((m = gcc.exec(t))) push({ file: m[1], line: +m[2], col: +m[3], severity: m[4], message: m[5] });
    // go build: ./main.go:12:5: undefined: x
    const gob = /^(\.?\.?\/?[^\s:][^:\n]*\.go):(\d+):(\d+): (.+)$/gm;
    while ((m = gob.exec(t))) push({ file: m[1], line: +m[2], col: +m[3], severity: 'error', message: m[4] });
    // rustc: error[E0308]: msg \n  --> src/main.rs:4:5
    const rust = /^(error|warning)(?:\[(\w+)\])?: (.+)\n\s*--> ([^:\n]+):(\d+):(\d+)/gm;
    while ((m = rust.exec(t))) push({ file: m[4], line: +m[5], col: +m[6], severity: m[1], code: m[2], message: m[3] });
    // eslint stylish: /path/file.ts \n  12:5  error  msg  rule
    const blocks = t.split(/\n(?=\S)/);
    for (const b of blocks) {
        const lines = b.split('\n');
        const file = lines[0].trim();
        if (!/\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(file)) continue;
        for (const l of lines.slice(1)) {
            const e = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/.exec(l);
            if (e) push({ file, line: +e[1], col: +e[2], severity: e[3], code: e[5], message: e[4] });
        }
    }
    // Python traceback (last frame)
    const tb = lastMatch(t, /File "([^"]+)", line (\d+)[^\n]*\n(?:.*\n)*?(\w+(?:Error|Exception)): (.*)/);
    if (tb && !items.length) push({ file: tb[1], line: +tb[2], severity: 'error', code: tb[3], message: tb[4] });
    // Gradle/Kotlin/Java: e: file:///x/A.kt:12:5 msg | A.java:12: error: msg
    const kt = /^([ew]): (?:file:\/\/)?(.+?\.kts?):(\d+):(\d+) (.+)$/gm;
    while ((m = kt.exec(t))) push({ file: m[2], line: +m[3], col: +m[4], severity: m[1] === 'e' ? 'error' : 'warning', message: m[5] });
    const jv = /^(.+?\.java):(\d+): (error|warning): (.+)$/gm;
    while ((m = jv.exec(t))) push({ file: m[1], line: +m[2], severity: m[3], message: m[4] });
    // MSBuild: file(12,5): error CS0103: msg [proj]
    const cs = /^(.+?)\((\d+),(\d+)\): (error|warning) ([A-Z]+\d+): (.+?)(?: \[.*\])?$/gm;
    while ((m = cs.exec(t))) push({ file: m[1].trim(), line: +m[2], col: +m[3], severity: m[4], code: m[5], message: m[6] });

    return { errors, warnings, items, files_with_issues: new Set(items.map(i => i.file)).size };
}

/** Last meaningful error-looking lines, used when nothing parses. */
export function errorExcerpt(raw: string, maxLines = 25): string {
    const lines = stripAnsi(raw).split('\n');
    const idx: number[] = [];
    lines.forEach((l, i) => { if (/(error|exception|failed|fatal|traceback|panic|cannot|not found|denied)/i.test(l)) idx.push(i); });
    if (!idx.length) return lines.slice(-maxLines).join('\n');
    const keep = new Set<number>();
    for (const i of idx.slice(-8)) for (let k = i - 2; k <= i + 3; k++) if (k >= 0 && k < lines.length) keep.add(k);
    const sorted = [...keep].sort((a, b) => a - b).slice(-maxLines * 2);
    const out: string[] = []; let prev = -2;
    for (const i of sorted) { if (i !== prev + 1) out.push('…'); out.push(lines[i]); prev = i; }
    return out.join('\n').slice(-6000);
}
