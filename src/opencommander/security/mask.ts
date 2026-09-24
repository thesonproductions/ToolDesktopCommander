/**
 * Secret masking for tool output.
 *
 * Only high-confidence token formats are masked by default, because masking
 * ordinary code would corrupt files the model later edits. Masked values look
 * like  [MASKED:openai_key]  and write tools refuse content containing that
 * marker, so a masked secret can never be written back over the real one.
 */

export const MASK_MARKER = '[MASKED:';

interface Rule { name: string; re: RegExp; keepGroup?: number }

const RULES: Rule[] = [
    { name: 'private_key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
    { name: 'aws_access_key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g },
    { name: 'aws_secret', re: /((?:aws_secret_access_key|aws_secret|secret_access_key)\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}/gi, keepGroup: 1 },
    { name: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/g },
    { name: 'gitlab_token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
    { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
    { name: 'openai_key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
    { name: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
    { name: 'slack_webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
    { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { name: 'stripe_key', re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/g },
    { name: 'huggingface_token', re: /\bhf_[A-Za-z0-9]{30,}\b/g },
    { name: 'npm_token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
    { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
    { name: 'url_password', re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{3,}(@)/gi, keepGroup: 1 },
    // KEY=value lines in env-like output, only for clearly secret-named keys
    { name: 'env_secret', re: /^((?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*["']?)(?!\[MASKED)[^\s"'#]{8,}/gm, keepGroup: 1 },
];

export function maskSecrets(text: string): { text: string; count: number; kinds: string[] } {
    if (!text) return { text, count: 0, kinds: [] };
    let count = 0;
    const kinds = new Set<string>();
    let out = text;
    for (const r of RULES) {
        out = out.replace(r.re, (...args: any[]) => {
            const m = args[0] as string;
            if (m.includes(MASK_MARKER)) return m;
            count++;
            kinds.add(r.name);
            if (r.keepGroup) {
                const keep = args[r.keepGroup] as string;
                const tailGroup = r.name === 'url_password' ? (args[2] as string) : '';
                return `${keep}${MASK_MARKER}${r.name}]${tailGroup}`;
            }
            return `${MASK_MARKER}${r.name}]`;
        });
    }
    return { text: out, count, kinds: [...kinds] };
}

export function containsMask(s: unknown): boolean {
    return typeof s === 'string' && s.includes(MASK_MARKER);
}
