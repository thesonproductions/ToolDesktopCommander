/**
 * Security policy: path protection + command risk classification.
 *
 * IMPORTANT: like upstream Desktop Commander this is a guardrail, not a
 * sandbox. A determined model could obfuscate a command. The goal is to stop
 * accidents (rm -rf, git reset --hard, force-push, reading ~/.ssh …) and to
 * require a *human* decision — made outside ChatGPT — for risky operations.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expandHome, getConfig } from '../config.js';
import { isWithin } from '../util.js';

export type Decision = 'allow' | 'approval' | 'deny';

export interface PolicyResult { decision: Decision; reasons: string[] }

interface Pattern { re: RegExp; reason: string }

const DENY: Pattern[] = [
    { re: /(^|[\s;&|(])(sudo\s+)?rm\s+(-[^\s]*\s+)*(-[^\s]*[rR][^\s]*)\s+(-[^\s]*\s+)*(["']?)(\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/|\$\{HOME\}|\/home|\/Users|[a-zA-Z]:[\\/]?)\6(\s|$|;|&)/, reason: 'recursive delete of a filesystem root or home directory' },
    { re: /\b(remove-item|ri|rd|rmdir|del|erase)\b[^;&|\n]*\s(["']?)([a-z]:\\?|[a-z]:\/|\$env:(userprofile|systemdrive|windir|homedrive)\\?|~\\?|~\/?|\\)\2(\s|$|;)/i, reason: 'delete of a drive root or user profile' },
    { re: /\bformat(\.com)?\s+[a-z]:/i, reason: 'formatting a drive' },
    { re: /\b(mkfs(\.\w+)?|diskpart|clear-disk|initialize-disk|format-volume|remove-partition)\b/i, reason: 'disk formatting/partitioning' },
    { re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|disk|mmcblk)/i, reason: 'raw write to a block device' },
    { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
    { re: /\b(vssadmin\s+delete\s+shadows|wbadmin\s+delete|bcdedit|cipher\s+\/w)\b/i, reason: 'destroys system recovery data / boot config' },
    { re: /\.opencommander([\\/"'\s]|$)/i, reason: 'access to OpenCommander state (token, approvals) is not allowed from tools' },
];

const APPROVAL: Pattern[] = [
    { re: /(^|[\s;&|(])(sudo\s+)?rm\s+(-[^\s]*\s+)*-[^\s]*[rR]/, reason: 'recursive delete (rm -r)' },
    { re: /(^|[\s;&|(])(sudo\s+)?rm\s+(-[^\s]*\s+)*--recursive/, reason: 'recursive delete (rm --recursive)' },
    { re: /\b(remove-item|ri|rm|del|erase|rd|rmdir)\b[^;&|\n]*\s(-recurse\b|-r\b|\/s\b)/i, reason: 'recursive delete' },
    { re: /\bfind\b[^;&|\n]*\s-delete\b|\bxargs\s+(-\S+\s+)*rm\b/i, reason: 'bulk delete via find/xargs' },
    { re: /\bgit\s+(-\S+\s+)*reset\s+[^;&|\n]*--hard\b/i, reason: 'git reset --hard discards changes' },
    { re: /\bgit\s+(-\S+\s+)*clean\s+[^;&|\n]*-[a-z]*f/i, reason: 'git clean -f deletes untracked files' },
    { re: /\bgit\s+(-\S+\s+)*push\b[^;&|\n]*(\s-f\b|--force|--mirror|--delete|\s:\S)/i, reason: 'force/destructive git push' },
    { re: /\bgit\s+(-\S+\s+)*push\b[^;&|\n]*\s\+\S/i, reason: 'force git push (+refspec)' },
    { re: /\bgit\s+(-\S+\s+)*branch\s+[^;&|\n]*-D\b/, reason: 'force-delete git branch' },
    { re: /\bgit\s+(-\S+\s+)*(checkout|restore)\s+[^;&|\n]*(--\s+\.|\s\.)(\s|$)/i, reason: 'discard working-tree changes' },
    { re: /\bgit\s+(-\S+\s+)*stash\s+(drop|clear)\b/i, reason: 'delete git stash' },
    { re: /\bgit\s+(-\S+\s+)*(filter-branch|filter-repo|update-ref\s+-d|reflog\s+expire|gc\s+[^;&|\n]*--prune)/i, reason: 'history rewrite / object pruning' },
    { re: /\bdocker\s+(system|image|volume|network|container|builder)\s+prune\b/i, reason: 'docker prune' },
    { re: /\bdocker\s+(volume\s+rm|rm\s+-f|rmi\s+-f)\b|\bdocker[- ]compose\b[^;&|\n]*\bdown\b[^;&|\n]*(-v\b|--volumes)/i, reason: 'docker delete with data loss' },
    { re: /\b(kubectl\s+delete|helm\s+(uninstall|delete)|terraform\s+(destroy|apply\s+[^;&|\n]*-auto-approve))\b/i, reason: 'infrastructure delete/apply' },
    { re: /(^|[;&|(\n]\s*|\bsudo\s+)(shutdown|reboot|halt|poweroff|logoff)(\.exe)?(\s|$)|\b(restart-computer|stop-computer)\b/i, reason: 'power/session control' },
    { re: /\bsystemctl\s+(stop|disable|mask|poweroff|reboot|halt)\b|\b(stop-service|remove-service)\b|\bsc(\.exe)?\s+(delete|stop|config)\b/i, reason: 'stopping/removing system services' },
    { re: /(^|[;&|(\n]\s*|\bsudo\s+)(killall|pkill)\s|\btaskkill\b[^;&|\n]*\/im\b|\bstop-process\b[^;&|\n]*-name\b/i, reason: 'killing processes by name' },
    { re: /\breg(\.exe)?\s+(delete|add|import)\b|\b(remove-itemproperty|set-itemproperty|new-itemproperty)\b[^;&|\n]*hk(lm|cu)/i, reason: 'registry modification' },
    { re: /\b(chmod|chown)\s+(-\S*R\S*|--recursive)\b|\bicacls\b[^;&|\n]*\/(grant|reset|remove|setowner)|\btakeown\b/i, reason: 'recursive permission/ownership change' },
    { re: /\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgh\s+(release\s+(create|delete)|repo\s+(delete|archive))\b|\bdotnet\s+nuget\s+push\b/i, reason: 'publishing / deleting releases' },
    { re: /\b(drop\s+(database|table|schema)|truncate\s+table)\b|\bdropdb\b/i, reason: 'destructive database statement' },
    { re: /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\|\s*(iex|invoke-expression)\b|\biex\s*\(|\binvoke-expression\b/i, reason: 'executes code downloaded from the internet' },
    { re: /(^|[\s;&|(])sudo\s|\brunas\b|-verb\s+runas\b/i, reason: 'privilege elevation' },
    { re: /\bset-executionpolicy\b|(^|[;&|(\n]\s*)setx\s|\bnetsh\b[^;&|\n]*(firewall|advfirewall)|\b(new|set|remove)-netfirewallrule\b/i, reason: 'system configuration change' },
    { re: /\bcrontab\s+-r\b|\bschtasks\b[^;&|\n]*\/(delete|create)\b|\b(un)?register-scheduledtask\b/i, reason: 'scheduled task change' },
];

function homeRelTokens(): Array<{ token: RegExp; path: string }> {
    const home = os.homedir();
    const out: Array<{ token: RegExp; path: string }> = [];
    for (const p of getConfig().security.protected_paths) {
        const abs = path.resolve(expandHome(p));
        const rel = path.relative(home, abs).replace(/\\/g, '/');
        if (!rel || rel.startsWith('..')) continue;
        const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]+');
        out.push({ token: new RegExp(`(^|[\\\\/\\s'"~=:])${esc}([\\\\/\\s'"]|$)`, 'i'), path: p });
    }
    return out;
}

export function classifyCommand(command: string): PolicyResult {
    const cfg = getConfig().security;
    const reasons: string[] = [];
    const cmd = command.replace(/\r/g, '');

    for (const d of DENY) if (d.re.test(cmd)) return { decision: 'deny', reasons: [d.reason] };
    const stateDir = path.resolve(process.env.OPENCOMMANDER_HOME || path.join(os.homedir(), '.opencommander'));
    if (cmd.toLowerCase().replace(/\\/g, '/').includes(stateDir.toLowerCase().replace(/\\/g, '/'))) {
        return { decision: 'deny', reasons: ['access to OpenCommander state (token, approvals) is not allowed from tools'] };
    }
    for (const p of cfg.extra_deny_patterns) {
        try { if (new RegExp(p, 'i').test(cmd)) return { decision: 'deny', reasons: [`matches deny pattern ${p}`] }; } catch { /* bad regex */ }
    }

    for (const t of homeRelTokens()) {
        if (t.token.test(cmd)) reasons.push(`touches protected path ${t.path}`);
    }
    if (cfg.profile !== 'open') {
        for (const a of APPROVAL) if (a.re.test(cmd)) reasons.push(a.reason);
        for (const p of cfg.extra_approval_patterns) {
            try { if (new RegExp(p, 'i').test(cmd)) reasons.push(`matches approval pattern ${p}`); } catch { /* ignore */ }
        }
        if (cfg.profile === 'strict' && !reasons.length) {
            const allowed = cfg.strict_allow_patterns.some(p => { try { return new RegExp(p, 'i').test(cmd); } catch { return false; } });
            const chained = /[;&|`]|\$\(/.test(cmd);
            if (!allowed || chained) reasons.push('strict profile: command not in strict_allow_patterns');
        }
    }
    return reasons.length ? { decision: 'approval', reasons: [...new Set(reasons)] } : { decision: 'allow', reasons: [] };
}

function realish(p: string): string {
    const abs = path.resolve(expandHome(p));
    try { return fs.realpathSync.native(abs); } catch { /* may not exist yet */ }
    // resolve the deepest existing parent so symlinked parents are still caught
    let cur = abs; const rest: string[] = [];
    while (cur !== path.dirname(cur)) {
        try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); } catch { rest.push(path.basename(cur)); cur = path.dirname(cur); }
    }
    return abs;
}

export function checkPath(p: string, mode: 'read' | 'write'): PolicyResult {
    if (!p || typeof p !== 'string') return { decision: 'allow', reasons: [] };
    if (/^https?:\/\//i.test(p)) return { decision: 'allow', reasons: [] };
    const cfg = getConfig().security;
    const abs = path.resolve(expandHome(p));
    const real = realish(p);
    const ocHomeDir = path.resolve(process.env.OPENCOMMANDER_HOME || path.join(os.homedir(), '.opencommander'));
    for (const cand of [abs, real]) {
        if (isWithin(cand, ocHomeDir)) return { decision: 'deny', reasons: ['OpenCommander state directory is not accessible through tools'] };
        for (const pp of cfg.protected_paths) {
            const prot = path.resolve(expandHome(pp));
            if (isWithin(cand, prot)) return { decision: 'deny', reasons: [`protected path ${pp} (${mode})`] };
        }
    }
    if (cfg.allowed_roots.length) {
        const inside = cfg.allowed_roots.some(r => isWithin(abs, path.resolve(expandHome(r))) || isWithin(real, path.resolve(expandHome(r))));
        // Allow listing the parents of roots (so the model can navigate to them), nothing else.
        if (!inside) return { decision: 'deny', reasons: [`outside allowed_roots (${cfg.allowed_roots.join(', ')})`] };
    }
    return { decision: 'allow', reasons: [] };
}

export function merge(results: PolicyResult[]): PolicyResult {
    if (results.some(r => r.decision === 'deny')) {
        return { decision: 'deny', reasons: results.filter(r => r.decision === 'deny').flatMap(r => r.reasons) };
    }
    const appr = results.filter(r => r.decision === 'approval');
    if (appr.length) return { decision: 'approval', reasons: [...new Set(appr.flatMap(r => r.reasons))] };
    return { decision: 'allow', reasons: [] };
}
