/**
 * Project detection: figure out how to test / lint / typecheck / build a repo
 * so the model can call `test_run` or `repo_verify` without guessing commands.
 */
import fs from 'fs';
import path from 'path';
import { IS_WIN } from './util.js';

export interface DetectedCommand { command: string; parser?: string; source: string }

export interface ProjectInfo {
    root: string;
    types: string[];
    package_manager?: string;
    python?: string;
    test?: DetectedCommand;
    lint?: DetectedCommand;
    typecheck?: DetectedCommand;
    build?: DetectedCommand;
    deps_check?: DetectedCommand;
    notes: string[];
}

const exists = (root: string, ...p: string[]) => fs.existsSync(path.join(root, ...p));
const read = (root: string, f: string) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };

function effectiveShell(shell: string): 'powershell' | 'cmd' | 'posix' {
    const s = (shell || 'auto').toLowerCase();
    if (s === 'auto') return IS_WIN ? 'powershell' : 'posix';
    if (s.includes('pwsh') || s.includes('powershell')) return 'powershell';
    if (s.includes('cmd')) return 'cmd';
    return 'posix';
}

/** Quote an executable path so it can be invoked in the given shell. */
export function invokeExe(exe: string, shell: string): string {
    const kind = effectiveShell(shell);
    if (!/[\s'"&()]/.test(exe) && !path.isAbsolute(exe)) return exe;
    if (kind === 'powershell') return `& '${exe.replace(/'/g, "''")}'`;
    if (kind === 'cmd') return `"${exe}"`;
    return `'${exe.replace(/'/g, `'\\''`)}'`;
}

function findPython(root: string, shell: string): { cmd: string; note?: string } {
    const candidates = IS_WIN
        ? ['.venv/Scripts/python.exe', 'venv/Scripts/python.exe', 'env/Scripts/python.exe']
        : ['.venv/bin/python', 'venv/bin/python', 'env/bin/python'];
    for (const c of candidates) {
        if (exists(root, c)) return { cmd: invokeExe(path.join(root, c), shell), note: `using virtualenv ${c}` };
    }
    if (exists(root, 'uv.lock')) return { cmd: 'uv run python', note: 'uv project' };
    if (exists(root, 'poetry.lock')) return { cmd: 'poetry run python', note: 'poetry project' };
    if (exists(root, 'environment.yml') || exists(root, 'environment.yaml')) {
        return { cmd: IS_WIN ? 'python' : 'python3', note: 'conda environment.yml found — activate the env or pass an explicit command' };
    }
    return { cmd: IS_WIN ? 'python' : 'python3' };
}

export function detectProject(root: string, shell = 'auto'): ProjectInfo {
    const info: ProjectInfo = { root, types: [], notes: [] };

    // ---------------- Node / TypeScript
    if (exists(root, 'package.json')) {
        info.types.push('node');
        let pkg: any = {};
        try { pkg = JSON.parse(read(root, 'package.json')); } catch { info.notes.push('package.json is not valid JSON'); }
        const pm = exists(root, 'pnpm-lock.yaml') ? 'pnpm' : exists(root, 'yarn.lock') ? 'yarn' : (exists(root, 'bun.lockb') || exists(root, 'bun.lock')) ? 'bun' : 'npm';
        info.package_manager = pm;
        const run = (s: string) => (pm === 'npm' ? `npm run ${s}` : `${pm} run ${s}`);
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const scripts = pkg.scripts || {};
        const parser = deps.vitest ? 'vitest' : deps.jest || deps['ts-jest'] ? 'jest' : deps.mocha ? 'mocha' : 'tap';
        if (scripts.test && !/no test specified/.test(scripts.test)) {
            info.test = { command: pm === 'npm' ? 'npm test' : `${pm} test`, parser, source: 'package.json scripts.test' };
        } else if (deps.vitest) info.test = { command: 'npx vitest run', parser: 'vitest', source: 'vitest dependency' };
        else if (deps.jest) info.test = { command: 'npx jest', parser: 'jest', source: 'jest dependency' };
        if (scripts.lint) info.lint = { command: run('lint'), source: 'package.json scripts.lint' };
        else if (deps.eslint) info.lint = { command: 'npx eslint .', source: 'eslint dependency' };
        if (scripts.typecheck) info.typecheck = { command: run('typecheck'), source: 'package.json scripts.typecheck' };
        else if (exists(root, 'tsconfig.json') && deps.typescript) info.typecheck = { command: 'npx tsc --noEmit -p .', source: 'tsconfig.json' };
        if (scripts.build) info.build = { command: run('build'), source: 'package.json scripts.build' };
    }

    // ---------------- Python
    const pyproject = read(root, 'pyproject.toml');
    const isPy = !!pyproject || exists(root, 'setup.py') || exists(root, 'requirements.txt') || exists(root, 'pytest.ini') || exists(root, 'setup.cfg') || exists(root, 'tox.ini');
    if (isPy) {
        info.types.push('python');
        const py = findPython(root, shell);
        info.python = py.cmd;
        if (py.note) info.notes.push(py.note);
        const hasPytest = /pytest/.test(pyproject) || exists(root, 'pytest.ini') || exists(root, 'conftest.py') || /pytest/.test(read(root, 'requirements.txt')) || /pytest/.test(read(root, 'requirements-dev.txt')) || exists(root, 'tests');
        if (!info.test) {
            info.test = hasPytest
                ? { command: `${py.cmd} -m pytest -rfE --tb=short`, parser: 'pytest', source: 'pytest config / tests dir' }
                : { command: `${py.cmd} -m unittest discover -v`, parser: 'unittest', source: 'python fallback' };
        }
        if (!info.lint) {
            if (/\[tool\.ruff/.test(pyproject) || exists(root, 'ruff.toml') || exists(root, '.ruff.toml')) info.lint = { command: `${py.cmd} -m ruff check .`, source: 'ruff config' };
            else if (exists(root, '.flake8') || /\[flake8\]/.test(read(root, 'setup.cfg'))) info.lint = { command: `${py.cmd} -m flake8`, source: 'flake8 config' };
        }
        if (!info.typecheck && (/\[tool\.mypy/.test(pyproject) || exists(root, 'mypy.ini'))) info.typecheck = { command: `${py.cmd} -m mypy .`, source: 'mypy config' };
        info.deps_check = { command: `${py.cmd} -m pip check`, source: 'pip check' };
    }

    // ---------------- Go
    if (exists(root, 'go.mod')) {
        info.types.push('go');
        info.test ??= { command: 'go test ./...', parser: 'go', source: 'go.mod' };
        info.lint ??= { command: 'go vet ./...', source: 'go.mod' };
        info.build ??= { command: 'go build ./...', source: 'go.mod' };
    }

    // ---------------- Rust
    if (exists(root, 'Cargo.toml')) {
        info.types.push('rust');
        info.test ??= { command: 'cargo test', parser: 'cargo', source: 'Cargo.toml' };
        info.lint ??= { command: 'cargo clippy --all-targets', source: 'Cargo.toml' };
        info.build ??= { command: 'cargo build', source: 'Cargo.toml' };
    }

    // ---------------- Gradle / Android
    if (exists(root, 'build.gradle') || exists(root, 'build.gradle.kts') || exists(root, 'settings.gradle') || exists(root, 'settings.gradle.kts')) {
        info.types.push('gradle');
        const kind = effectiveShell(shell);
        const gw = exists(root, 'gradlew') || exists(root, 'gradlew.bat')
            ? (IS_WIN ? (kind === 'powershell' ? '.\\gradlew.bat' : 'gradlew.bat') : './gradlew')
            : 'gradle';
        const android = /com\.android\.(application|library)/.test(read(root, 'app/build.gradle') + read(root, 'app/build.gradle.kts') + read(root, 'build.gradle') + read(root, 'build.gradle.kts'));
        if (android) info.types.push('android');
        info.test ??= { command: `${gw} ${android ? 'testDebugUnitTest' : 'test'} --console=plain`, parser: 'jvm', source: 'gradle' };
        info.build ??= { command: `${gw} ${android ? 'assembleDebug' : 'assemble'} --console=plain`, source: 'gradle' };
        if (android) info.lint ??= { command: `${gw} lintDebug --console=plain`, source: 'android gradle' };
    }

    // ---------------- Maven
    if (exists(root, 'pom.xml')) {
        info.types.push('maven');
        const mvn = exists(root, 'mvnw') || exists(root, 'mvnw.cmd') ? (IS_WIN ? '.\\mvnw.cmd' : './mvnw') : 'mvn';
        info.test ??= { command: `${mvn} -B test`, parser: 'jvm', source: 'pom.xml' };
        info.build ??= { command: `${mvn} -B -DskipTests package`, source: 'pom.xml' };
    }

    // ---------------- .NET
    let hasDotnet = false;
    try { hasDotnet = fs.readdirSync(root).some(f => /\.(sln|csproj|fsproj)$/.test(f)); } catch { /* ignore */ }
    if (hasDotnet) {
        info.types.push('dotnet');
        info.test ??= { command: 'dotnet test', parser: 'jvm', source: '.sln/.csproj' };
        info.build ??= { command: 'dotnet build', source: '.sln/.csproj' };
    }

    // ---------------- Docker
    if (exists(root, 'docker-compose.yml') || exists(root, 'docker-compose.yaml') || exists(root, 'compose.yml') || exists(root, 'compose.yaml')) info.types.push('docker-compose');
    else if (exists(root, 'Dockerfile')) info.types.push('docker');

    // ---------------- Makefile fallbacks
    const mk = read(root, 'Makefile');
    if (mk) {
        info.types.push('make');
        if (!info.test && /^test:/m.test(mk)) info.test = { command: 'make test', source: 'Makefile' };
        if (!info.lint && /^lint:/m.test(mk)) info.lint = { command: 'make lint', source: 'Makefile' };
        if (!info.build && /^build:/m.test(mk)) info.build = { command: 'make build', source: 'Makefile' };
    }
    return info;
}
