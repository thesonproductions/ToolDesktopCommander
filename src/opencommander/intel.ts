/**
 * Repository intelligence — ripgrep + light parsing, no native deps.
 *
 * Goal: answer "where is X defined / used / tested, what does this file import,
 * what is this repo" in ONE tool call instead of 5–10 search/read round trips.
 */
import fs from 'fs';
import path from 'path';
import { getRipgrepPath } from '../utils/ripgrep-resolver.js';
import { detectProject } from './detect.js';
import { repoRoot, status as gitStatus } from './git.js';
import { execFile, ToolError, truncateEnd } from './util.js';

const LANG: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
    py: 'Python', pyi: 'Python', ipynb: 'Jupyter', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala',
    cs: 'C#', fs: 'F#', c: 'C', h: 'C/C++ header', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++', m: 'Objective-C/MATLAB', mm: 'Objective-C++',
    swift: 'Swift', rb: 'Ruby', php: 'PHP', lua: 'Lua', r: 'R', jl: 'Julia', dart: 'Dart', vue: 'Vue', svelte: 'Svelte',
    f90: 'Fortran', f95: 'Fortran', f: 'Fortran', for: 'Fortran', f03: 'Fortran', cu: 'CUDA', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell',
    sql: 'SQL', html: 'HTML', css: 'CSS', scss: 'SCSS', md: 'Markdown', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
    gradle: 'Gradle', tf: 'Terraform', proto: 'Protobuf',
};
const CODE_EXT = new Set(Object.keys(LANG).filter(e => !['md', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'scss', 'ipynb'].includes(e)));

const TEST_RE = /(^|[\\/])(tests?|__tests__|spec|specs|testing)[\\/]|(^|[\\/])test_[^\\/]+\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$|(Test|Tests|Spec)\.(java|kt|cs|scala|swift)$|_spec\.rb$/;

export const isTestFile = (f: string) => TEST_RE.test(f.replace(/\\/g, '/'));

async function rg(args: string[], cwd: string, timeoutMs = 60000) {
    const bin = await getRipgrepPath();
    return execFile(bin, args, { cwd, timeoutMs, maxBytes: 64 * 1024 * 1024 });
}

export async function resolveRoot(p: string): Promise<string> {
    if (!p) throw new ToolError('path is required');
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) throw new ToolError(`Path does not exist: ${abs}`);
    const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    return (await repoRoot(dir)) || dir;
}

export async function listFiles(root: string, max = 60000): Promise<{ files: string[]; truncated: boolean }> {
    const r = await rg(['--files', '--hidden', '-g', '!.git', '-g', '!node_modules', '-g', '!.venv', '-g', '!venv', '-g', '!__pycache__', '-g', '!dist', '-g', '!build', '-g', '!.gradle', '-g', '!target'], root);
    const files = r.stdout.split(/\r?\n/).filter(Boolean).map(f => f.replace(/\\/g, '/')).sort();
    return { files: files.slice(0, max), truncated: files.length > max };
}

function extOf(f: string): string {
    const b = f.split('/').pop() || '';
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

// ------------------------------------------------------------------ overview

export async function overview(p: string, depth = 2) {
    const root = await resolveRoot(p);
    const { files, truncated } = await listFiles(root);
    const byLang: Record<string, number> = {};
    const tree: Record<string, number> = {};
    let tests = 0;
    for (const f of files) {
        const e = extOf(f);
        if (LANG[e]) byLang[LANG[e]] = (byLang[LANG[e]] || 0) + 1;
        if (isTestFile(f)) tests++;
        const parts = f.split('/');
        const key = parts.length > 1 ? parts.slice(0, Math.min(depth, parts.length - 1)).join('/') + '/' : '(root files)';
        tree[key] = (tree[key] || 0) + 1;
    }
    const langs = Object.entries(byLang).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([l, n]) => `${l}: ${n}`);
    const dirsList = Object.entries(tree).sort((a, b) => a[0].localeCompare(b[0])).slice(0, 80).map(([d, n]) => `${d} (${n})`);
    const manifests: Record<string, unknown> = {};
    const readText = (f: string) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
    if (files.includes('package.json')) {
        try {
            const pkg = JSON.parse(readText('package.json'));
            manifests['package.json'] = {
                name: pkg.name, version: pkg.version, type: pkg.type, main: pkg.main, bin: pkg.bin,
                scripts: Object.keys(pkg.scripts || {}).slice(0, 30),
                dependencies: Object.keys(pkg.dependencies || {}).slice(0, 40),
                devDependencies: Object.keys(pkg.devDependencies || {}).length,
            };
        } catch { manifests['package.json'] = 'invalid JSON'; }
    }
    const py = readText('pyproject.toml');
    if (py) {
        manifests['pyproject.toml'] = {
            name: /^name\s*=\s*["']([^"']+)/m.exec(py)?.[1],
            requires_python: /requires-python\s*=\s*["']([^"']+)/.exec(py)?.[1],
            tools: [...new Set([...py.matchAll(/^\[tool\.([\w-]+)/gm)].map(m => m[1]))],
        };
    }
    if (files.includes('requirements.txt')) manifests['requirements.txt'] = readText('requirements.txt').split(/\r?\n/).filter(l => l && !l.startsWith('#')).slice(0, 40);
    if (files.includes('go.mod')) manifests['go.mod'] = /^module\s+(\S+)/m.exec(readText('go.mod'))?.[1];
    if (files.includes('Cargo.toml')) manifests['Cargo.toml'] = /^name\s*=\s*"([^"]+)"/m.exec(readText('Cargo.toml'))?.[1];
    const entryCandidates = ['main.py', 'app.py', 'manage.py', 'run.py', 'src/main.py', 'src/index.ts', 'src/main.ts', 'src/index.js', 'index.js', 'src/main.rs', 'main.go', 'Program.cs', 'src/App.tsx', 'app/src/main/AndroidManifest.xml'];
    const entrypoints = [
        ...entryCandidates.filter(c => files.includes(c)),
        ...files.filter(f => /^cmd\/[^/]+\/main\.go$/.test(f) || /__main__\.py$/.test(f)).slice(0, 10),
    ];
    const readme = files.find(f => /^readme(\.md|\.rst|\.txt)?$/i.test(f));
    const project = detectProject(root);
    let git: unknown = null;
    try {
        const s = await gitStatus(root, 20);
        git = { branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, clean: s.clean, counts: s.counts, recent_commits: s.recent_commits.slice(0, 3), in_progress: s.in_progress };
    } catch { git = 'not a git repository'; }
    return {
        root,
        files: files.length, files_truncated: truncated || undefined,
        languages: langs,
        test_files: tests,
        directories: dirsList,
        manifests,
        entrypoints,
        detected: {
            types: project.types, python: project.python, package_manager: project.package_manager,
            test: project.test?.command, lint: project.lint?.command, typecheck: project.typecheck?.command, build: project.build?.command, notes: project.notes,
        },
        git,
        readme_head: readme ? truncateEnd(readText(readme).split(/\r?\n/).slice(0, 40).join('\n'), 2000) : undefined,
    };
}

// ------------------------------------------------------------------ symbols

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function defPatterns(name: string): string[] {
    const n = esc(name);
    return [
        // JS/TS
        `(export\\s+)?(default\\s+)?(async\\s+)?function\\*?\\s+${n}\\b`,
        `(export\\s+)?(default\\s+)?(abstract\\s+)?class\\s+${n}\\b`,
        `(export\\s+)?(declare\\s+)?(interface|type|enum|namespace)\\s+${n}\\b`,
        `(export\\s+)?(const|let|var)\\s+${n}\\s*[=:]`,
        `^\\s*(public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|readonly\\s+|override\\s+|get\\s+|set\\s+)*${n}\\s*(<[^>]*>)?\\([^)]*\\)\\s*(:\\s*[^={;]+)?\\{\\s*$`,
        // Python
        `^\\s*(async\\s+)?def\\s+${n}\\b`,
        `^\\s*class\\s+${n}\\b`,
        `^${n}\\s*(:[^=]+)?=[^=]`,
        // Go
        `^func\\s+(\\([^)]*\\)\\s*)?${n}\\b`,
        `^\\s*type\\s+${n}\\b`,
        // Rust
        `(pub(\\([^)]*\\))?\\s+)?(async\\s+)?(unsafe\\s+)?(fn|struct|enum|trait|type|mod|const|static|union|macro_rules!)\\s+${n}\\b`,
        `impl(<[^>]*>)?\\s+([\\w:]+\\s+for\\s+)?${n}\\b`,
        // Java / Kotlin / C# / Scala / Swift / Dart
        `\\b(class|interface|enum|record|object|struct|protocol|extension|trait)\\s+${n}\\b`,
        `\\bfun\\s+(<[^>]*>\\s*)?([\\w.]+\\.)?${n}\\s*\\(`,
        `\\b(func|def)\\s+${n}\\s*[(<\\[]`,
        `^\\s*(public|private|protected|internal|static|final|override|virtual|abstract|async|synchronized|\\s)+[\\w<>\\[\\],.?]+\\s+${n}\\s*\\(`,
        // C/C++
        `#define\\s+${n}\\b`,
        `^\\s*(typedef\\s+)?(struct|union|enum|class)\\s+${n}\\b`,
        `^[A-Za-z_][\\w\\s\\*&:<>,]*[\\s\\*&]${n}\\s*\\([^;]*$`,
        // Fortran
        `(?i)^\\s*(recursive\\s+|pure\\s+|elemental\\s+)*(subroutine|function|module|program)\\s+${n}\\b`,
        // Ruby / PHP / Lua
        `\\bdef\\s+(self\\.)?${n}\\b`, `\\bmodule\\s+${n}\\b`, `\\bfunction\\s+${n}\\s*\\(`,
    ];
}

function kindOf(line: string): string {
    const l = line.trim();
    if (/^(export\s+)?(default\s+)?(abstract\s+)?class\b|^\s*class\b/.test(l) || /\b(class|record)\s/.test(l)) return 'class';
    if (/\binterface\s/.test(l)) return 'interface';
    if (/\b(struct|union)\s/.test(l)) return 'struct';
    if (/\benum\s/.test(l)) return 'enum';
    if (/\btrait\s|\bprotocol\s/.test(l)) return 'trait';
    if (/^(export\s+)?(declare\s+)?type\s|^\s*type\s/.test(l)) return 'type';
    if (/\bimpl\b/.test(l)) return 'impl';
    if (/#define/.test(l)) return 'macro';
    if (/\b(def|function|fun|fn|func|subroutine)\b/i.test(l)) return 'function';
    if (/\b(const|let|var|static)\s/.test(l) || /^[A-Za-z_]\w*\s*(:[^=]+)?=/.test(l)) return 'variable';
    if (/\(/.test(l)) return 'method';
    return 'symbol';
}

export async function findSymbol(p: string, name: string, o: { include_references?: boolean; max_references?: number; glob?: string } = {}) {
    if (!/^[\w$.:-]+$/.test(name)) throw new ToolError('name must be an identifier (letters, digits, _ $ . : -)');
    const root = await resolveRoot(p);
    const simple = name.split(/[.:]+/).pop()!;
    const pats = defPatterns(simple);
    const args = ['-n', '--no-heading', '--color=never', '--max-columns=300', '-g', '!node_modules', '-g', '!dist', '-g', '!build', '-g', '!*.min.js', '-g', '!.venv'];
    if (o.glob) args.push('-g', o.glob);
    for (const pt of pats) args.push('-e', pt);
    args.push('.');
    const r = await rg(args, root);
    const defs: Array<{ file: string; line: number; kind: string; text: string }> = [];
    const defKeys = new Set<string>();
    for (const l of r.stdout.split(/\r?\n/)) {
        const m = /^(.+?):(\d+):(.*)$/.exec(l);
        if (!m) continue;
        const text = m[3].trim();
        if (/^\s*(\/\/|#(?!define)|\*|--|!)/.test(m[3]) && !/^\s*#define/.test(m[3])) continue; // comments
        if (/^\s*(return|if|while|for|switch|else|await|yield|new)\b/.test(text)) continue;
        if (!new RegExp(`\\b${esc(simple)}\\b`).test(text)) continue;
        const file = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
        defKeys.add(`${file}:${m[2]}`);
        if (defs.length < 40) defs.push({ file, line: Number(m[2]), kind: kindOf(text), text: text.slice(0, 200) });
    }
    // Prefer non-test definitions first
    defs.sort((a, b) => Number(isTestFile(a.file)) - Number(isTestFile(b.file)));
    const res: Record<string, unknown> = { root, symbol: name, definitions: defs };
    if (o.include_references !== false) {
        const max = Math.min(Math.max(o.max_references ?? 60, 1), 500);
        const rr = await rg(['-n', '--no-heading', '--color=never', '-w', '-F', '--max-columns=240', '-g', '!node_modules', '-g', '!dist', '-g', '!build', '-g', '!*.min.js', '-g', '!.venv', ...(o.glob ? ['-g', o.glob] : []), simple, '.'], root);
        const refs: string[] = [];
        let total = 0;
        const perFile: Record<string, number> = {};
        for (const l of rr.stdout.split(/\r?\n/)) {
            const m = /^(.+?):(\d+):(.*)$/.exec(l);
            if (!m) continue;
            const file = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
            if (defKeys.has(`${file}:${m[2]}`)) continue;
            total++;
            perFile[file] = (perFile[file] || 0) + 1;
            if (refs.length < max) refs.push(`${file}:${m[2]}: ${m[3].trim().slice(0, 160)}`);
        }
        res.references_total = total;
        res.reference_files = Object.keys(perFile).length;
        res.references = refs;
        res.test_references = Object.keys(perFile).filter(isTestFile).slice(0, 30);
    }
    return res;
}

// ------------------------------------------------------------------ outline

interface OutlineItem { line: number; kind: string; name: string; depth: number; signature: string }

export function outline(file: string, max = 400): { file: string; language: string; lines: number; items: OutlineItem[] } {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    const e = extOf(file.replace(/\\/g, '/'));
    const lang = LANG[e] || 'unknown';
    const items: OutlineItem[] = [];
    const add = (i: number, kind: string, name: string, indent: number) => {
        if (items.length < max) items.push({ line: i + 1, kind, name, depth: Math.floor(indent / 2), signature: lines[i].trim().slice(0, 180) });
    };
    lines.forEach((ln, i) => {
        const indent = (/^\s*/.exec(ln)?.[0] || '').replace(/\t/g, '    ').length;
        let m: RegExpExecArray | null;
        if (lang === 'Python') {
            if ((m = /^\s*(async\s+)?def\s+(\w+)/.exec(ln))) add(i, indent ? 'method' : 'function', m[2], indent / 2);
            else if ((m = /^\s*class\s+(\w+)/.exec(ln))) add(i, 'class', m[1], indent / 2);
            else if (!indent && (m = /^([A-Z_][A-Z0-9_]+)\s*(:[^=]+)?=/.exec(ln))) add(i, 'constant', m[1], 0);
            return;
        }
        if (lang === 'TypeScript' || lang === 'JavaScript' || lang === 'Vue' || lang === 'Svelte') {
            if ((m = /^\s*(export\s+)?(default\s+)?(async\s+)?function\*?\s+(\w+)/.exec(ln))) add(i, 'function', m[4], indent);
            else if ((m = /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+(\w+)/.exec(ln))) add(i, 'class', m[4], indent);
            else if ((m = /^\s*(export\s+)?(declare\s+)?(interface|type|enum|namespace)\s+(\w+)/.exec(ln))) add(i, m[3], m[4], indent);
            else if ((m = /^\s*(export\s+)?(const|let|var)\s+(\w+)\s*(:[^=]+)?=\s*(async\s+)?(\([^)]*\)|\w+)\s*=>/.exec(ln))) add(i, 'function', m[3], indent);
            else if (indent <= 4 && (m = /^\s*export\s+(const|let|var)\s+(\w+)/.exec(ln))) add(i, 'variable', m[2], indent);
            else if (indent > 0 && indent <= 8 && (m = /^\s*(public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|override\s+|get\s+|set\s+)*(\w+)\s*(<[^>]*>)?\([^)]*\)?\s*(:\s*[^={;]+)?\{\s*$/.exec(ln)) && !/^(if|for|while|switch|catch|function|return)$/.test(m[2])) add(i, 'method', m[2], indent);
            return;
        }
        if (lang === 'Go') {
            if ((m = /^func\s+(\([^)]*\)\s*)?(\w+)/.exec(ln))) add(i, m[1] ? 'method' : 'function', m[2], 0);
            else if ((m = /^type\s+(\w+)\s+(struct|interface)?/.exec(ln))) add(i, m[2] || 'type', m[1], 0);
            return;
        }
        if (lang === 'Rust') {
            if ((m = /^\s*(pub(\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?(fn|struct|enum|trait|type|mod|const|static|macro_rules!)\s+(\w+)/.exec(ln))) add(i, m[5], m[6], indent / 4);
            else if ((m = /^\s*impl(<[^>]*>)?\s+(.+?)\s*\{/.exec(ln))) add(i, 'impl', m[2], indent / 4);
            return;
        }
        if (lang === 'Fortran') {
            if ((m = /^\s*(recursive\s+|pure\s+|elemental\s+)*(subroutine|function|module|program|type)\s+(\w+)/i.exec(ln)) && !/^\s*end\b/i.test(ln)) add(i, m[2].toLowerCase(), m[3], indent / 2);
            return;
        }
        // Java / Kotlin / C# / C / C++ / Swift / others (heuristic)
        if ((m = /^\s*(?:[\w@]+\s+)*(class|interface|enum|record|object|struct|protocol|trait)\s+(\w+)/.exec(ln))) add(i, m[1], m[2], indent / 4);
        else if ((m = /^\s*(?:(?:public|private|protected|internal|override|suspend|inline|open|static)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/.exec(ln))) add(i, 'function', m[1], indent / 4);
        else if ((m = /^\s*(?:(?:public|private|protected|internal|static|final|override|virtual|abstract|async|synchronized|inline|extern|const|unsigned)\s+)*[\w<>\[\],.?*&:]+\s+[*&]?(\w+)\s*\([^;]*\)\s*(const\s*)?(\{|$|throws)/.exec(ln)) && !/^(if|for|while|switch|catch|return|else|new)$/.test(m[1])) add(i, 'function', m[1], indent / 4);
        else if ((m = /^#define\s+(\w+)/.exec(ln))) add(i, 'macro', m[1], 0);
    });
    return { file, language: lang, lines: lines.length, items };
}

// ------------------------------------------------------------------ imports

export interface ImportRef { spec: string; line: number; resolved?: string; local: boolean }

const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.json'];

function resolveJs(fromFile: string, spec: string, root: string): string | undefined {
    if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/') && !spec.startsWith('~/')) return undefined;
    let base = spec.startsWith('@/') || spec.startsWith('~/') ? path.join(root, 'src', spec.slice(2)) : path.resolve(path.dirname(fromFile), spec);
    const candidates = [base, ...JS_EXT.map(e => base + e), ...JS_EXT.map(e => path.join(base, 'index' + e))];
    if (/\.(m|c)?js$/.test(base)) {
        const noExt = base.replace(/\.(m|c)?js$/, '');
        candidates.push(...['.ts', '.tsx', '.mts', '.cts'].map(e => noExt + e));
    }
    for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
    return undefined;
}

function resolvePy(fromFile: string, spec: string, root: string): string | undefined {
    let baseDirs: string[];
    let mod = spec;
    if (spec.startsWith('.')) {
        const dots = /^\.+/.exec(spec)![0].length;
        let d = path.dirname(fromFile);
        for (let i = 1; i < dots; i++) d = path.dirname(d);
        baseDirs = [d];
        mod = spec.slice(dots);
    } else {
        baseDirs = [root, path.join(root, 'src'), path.join(root, 'lib'), path.join(root, 'app')];
    }
    const rel = mod.split('.').filter(Boolean).join(path.sep);
    for (const b of baseDirs) {
        for (const c of [path.join(b, rel + '.py'), path.join(b, rel, '__init__.py'), path.join(b, rel + '.pyi')]) {
            try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
        }
    }
    return undefined;
}

export function parseImports(file: string, root: string): ImportRef[] {
    const text = fs.readFileSync(file, 'utf8');
    const e = extOf(file.replace(/\\/g, '/'));
    const lang = LANG[e] || '';
    const out: ImportRef[] = [];
    const lines = text.split(/\r?\n/);
    const add = (spec: string, line: number, resolved?: string, localHint?: boolean) =>
        out.push({ spec, line, resolved: resolved ? path.relative(root, resolved).replace(/\\/g, '/') : undefined, local: localHint ?? !!resolved });
    if (lang === 'TypeScript' || lang === 'JavaScript' || lang === 'Vue' || lang === 'Svelte') {
        const re = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            const spec = m[1] || m[2] || m[3];
            const line = text.slice(0, m.index).split('\n').length;
            add(spec, line, resolveJs(file, spec, root), spec.startsWith('.'));
        }
    } else if (lang === 'Python') {
        lines.forEach((l, i) => {
            let m = /^\s*from\s+(\S+)\s+import\s+(.+)/.exec(l);
            if (m) {
                const base = m[1];
                let resolved = resolvePy(file, base, root);
                if (!resolved && base.match(/^\.+$/)) {
                    // from . import x, y
                    for (const name of m[2].replace(/[()]/g, '').split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
                        const r = resolvePy(file, base + name, root);
                        add(`${base}${name}`, i + 1, r, true);
                    }
                    return;
                }
                add(base, i + 1, resolved, base.startsWith('.'));
                return;
            }
            m = /^\s*import\s+(.+)/.exec(l);
            if (m) for (const s of m[1].split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) add(s, i + 1, resolvePy(file, s, root));
        });
    } else if (lang === 'Go') {
        const block = /import\s*\(([\s\S]*?)\)/g; let m: RegExpExecArray | null;
        while ((m = block.exec(text))) for (const s of m[1].matchAll(/"([^"]+)"/g)) add(s[1], text.slice(0, m.index).split('\n').length, undefined, false);
        for (const s of text.matchAll(/^import\s+(?:\w+\s+)?"([^"]+)"/gm)) add(s[1], text.slice(0, s.index).split('\n').length, undefined, false);
    } else if (lang === 'Rust') {
        lines.forEach((l, i) => {
            const m = /^\s*(?:pub\s+)?(use|mod)\s+([^;{]+)/.exec(l);
            if (m) add(`${m[1]} ${m[2].trim()}`, i + 1, undefined, /^(crate|self|super)::/.test(m[2]) || m[1] === 'mod');
        });
    } else if (['Java', 'Kotlin', 'Scala', 'C#', 'Swift', 'Dart'].includes(lang)) {
        lines.forEach((l, i) => {
            const m = /^\s*(?:import|using)\s+(?:static\s+)?([\w.*]+)/.exec(l);
            if (m && !/^\s*using\s*\(/.test(l)) add(m[1], i + 1, undefined, false);
        });
    } else if (/C|C\+\+|Objective|CUDA/.test(lang)) {
        lines.forEach((l, i) => {
            const m = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/.exec(l);
            if (m) {
                const r = m[1] === '"' ? path.resolve(path.dirname(file), m[2]) : undefined;
                add(m[2], i + 1, r && fs.existsSync(r) ? r : undefined, m[1] === '"');
            }
        });
    } else if (lang === 'Fortran') {
        lines.forEach((l, i) => {
            const m = /^\s*use\s+(\w+)/i.exec(l);
            if (m) add(m[1], i + 1, undefined, false);
        });
    }
    return out;
}

export async function importers(file: string, root: string, max = 60): Promise<string[]> {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    const base = path.basename(file).replace(/\.[^.]+$/, '');
    if (!base) return [];
    const target = base === 'index' || base === '__init__' ? path.basename(path.dirname(file)) : base;
    const r = await rg(['-l', '--color=never', '-g', '!node_modules', '-g', '!dist', '-g', '!.venv', '-e', `(import|from|require|use|include|using)\\b.*\\b${esc(target)}\\b`, '.'], root);
    const out: string[] = [];
    for (const f of r.stdout.split(/\r?\n/).filter(Boolean)) {
        const abs = path.resolve(root, f);
        if (path.resolve(abs) === path.resolve(file)) continue;
        try {
            const imps = parseImports(abs, root);
            if (imps.some(i => i.resolved === rel) || imps.some(i => !i.resolved && i.spec.split(/[./:]/).includes(target) && (LANG[extOf(abs)] === LANG[extOf(file)]))) {
                out.push(path.relative(root, abs).replace(/\\/g, '/'));
            }
        } catch { /* unreadable */ }
        if (out.length >= max) break;
    }
    return out;
}

// ------------------------------------------------------------------ related tests

export async function related(p: string) {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new ToolError(`Not a file: ${abs}`);
    const root = await resolveRoot(abs);
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    const { files } = await listFiles(root);
    const b = path.basename(abs);
    const ext = extOf(rel);
    const stem = b.slice(0, b.length - (ext ? ext.length + 1 : 0));
    const isTest = isTestFile(rel);
    const res: Record<string, unknown> = { root, file: rel, is_test: isTest };

    const imports = parseImports(abs, root);
    res.imports_local = imports.filter(i => i.local).map(i => i.resolved || i.spec).slice(0, 60);
    res.imports_external = [...new Set(imports.filter(i => !i.local).map(i => i.spec.split('/')[0]))].slice(0, 40);
    const imp = await importers(abs, root);
    res.imported_by = imp;

    if (!isTest) {
        const names = new Set([
            `test_${stem}.py`, `${stem}_test.py`, `${stem}_test.go`, `${stem}Test.java`, `${stem}Tests.java`, `${stem}Test.kt`, `${stem}Tests.kt`,
            `${stem}Tests.cs`, `${stem}Test.cs`, `${stem}_spec.rb`, `${stem}Spec.scala`, `${stem}Tests.swift`,
            ...['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].flatMap(x => [`${stem}.test.${x}`, `${stem}.spec.${x}`]),
        ]);
        const byName = files.filter(f => names.has(f.split('/').pop()!) || (isTestFile(f) && f.includes('/__tests__/') && f.split('/').pop()!.startsWith(stem + '.')));
        const byImport = imp.filter(isTestFile);
        const byMention = files.filter(f => isTestFile(f) && f.toLowerCase().includes(stem.toLowerCase()) && !byName.includes(f));
        res.tests = [...new Set([...byName, ...byImport])].slice(0, 30);
        if (!(res.tests as string[]).length) res.tests_maybe = byMention.slice(0, 15);
    } else {
        const srcStem = stem.replace(/^test_|_test$|\.test$|\.spec$|Tests?$|_spec$|Spec$/g, '');
        res.sources_under_test = [
            ...new Set([
                ...imports.filter(i => i.local && i.resolved && !isTestFile(i.resolved)).map(i => i.resolved!),
                ...files.filter(f => !isTestFile(f) && CODE_EXT.has(extOf(f)) && f.split('/').pop()!.replace(/\.[^.]+$/, '') === srcStem),
            ]),
        ].slice(0, 20);
    }
    return res;
}

// ------------------------------------------------------------------ search

export async function search(p: string, query: string, o: { regex?: boolean; glob?: string; case_sensitive?: boolean; context?: number; max_results?: number; max_per_file?: number; files_only?: boolean }) {
    const root = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.resolve(p) : await resolveRoot(p);
    const args = ['-n', '--no-heading', '--color=never', '--max-columns=300', '--max-columns-preview', '-g', '!node_modules', '-g', '!.git', '-g', '!.venv', '-g', '!dist', '-g', '!*.min.js', '--hidden'];
    if (!o.regex) args.push('-F');
    if (!o.case_sensitive) args.push('-S');
    if (o.glob) for (const g of o.glob.split(',').map(s => s.trim()).filter(Boolean)) args.push('-g', g);
    const perFile = Math.min(Math.max(o.max_per_file ?? 8, 1), 200);
    if (o.files_only) args.push('-l'); else args.push('-m', String(perFile));
    const ctx = Math.min(Math.max(o.context ?? 0, 0), 10);
    if (ctx && !o.files_only) args.push('-C', String(ctx));
    args.push('-e', query, '.');
    const r = await rg(args, root);
    if (r.code === 2) throw new ToolError(`search failed: ${r.stderr.trim().slice(0, 500)}`);
    const max = Math.min(Math.max(o.max_results ?? 120, 1), 2000);
    const lines = r.stdout.split(/\r?\n/).filter(Boolean).map(l => l.replace(/^\.[\\/]/, ''));
    const files = new Set<string>();
    for (const l of lines) { const m = /^(.+?)[:-](\d+)[:-]/.exec(l); files.add(m ? m[1] : l); }
    return {
        root, query, total_lines: lines.length, files: files.size,
        truncated: lines.length > max || undefined,
        results: lines.slice(0, max).join('\n'),
    };
}

// ------------------------------------------------------------------ read ranges

export function readRanges(items: Array<{ path: string; start_line?: number; end_line?: number }>, maxChars = 50000) {
    const out: Array<Record<string, unknown>> = [];
    let budget = maxChars;
    for (const it of items.slice(0, 30)) {
        try {
            const text = fs.readFileSync(it.path, 'utf8');
            const lines = text.split(/\r?\n/);
            const s = Math.max(1, it.start_line ?? 1);
            const e = Math.min(lines.length, it.end_line ?? Math.min(lines.length, s + 199));
            let body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}| ${l}`).join('\n');
            let cut = false;
            if (body.length > budget) { body = body.slice(0, Math.max(0, budget)); cut = true; }
            budget -= body.length;
            out.push({ path: it.path, start_line: s, end_line: e, total_lines: lines.length, truncated: cut || undefined, content: body });
            if (budget <= 0) { out.push({ note: 'output budget exhausted; request remaining ranges separately' }); break; }
        } catch (e) {
            out.push({ path: it.path, error: (e as Error).message });
        }
    }
    return out;
}
