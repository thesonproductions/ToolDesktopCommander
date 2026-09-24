/**
 * Central guard around EVERY tool call (upstream Desktop Commander tools and
 * OpenCommander tools): policy → approval → execution with a hard time budget
 * → secret masking → output cap → audit.
 */
import { getConfig } from './config.js';
import { audit } from './audit.js';
import { checkPath, classifyCommand, merge, PolicyResult } from './security/policy.js';
import { consume, requestApproval } from './security/approvals.js';
import { containsMask, maskSecrets, MASK_MARKER } from './security/mask.js';
import { callOcTool, OC_TOOL_NAMES } from './tools.js';
import { truncateMiddle } from './util.js';

type AnyResult = { content?: Array<{ type: string; text?: string; [k: string]: unknown }>; isError?: boolean; [k: string]: unknown };

export function currentTransport(): 'http' | 'stdio' {
    return (global as any).__ocTransport === 'http' ? 'http' : 'stdio';
}

const SAFE_CONFIG_KEYS = new Set(['fileReadLineLimit', 'fileWriteLineLimit']);

interface Evaluation { policy: PolicyResult; summary: string }

function evaluate(name: string, args: Record<string, any>): Evaluation {
    const results: PolicyResult[] = [];
    const cmds: string[] = [];
    const reads: string[] = [];
    const writes: string[] = [];
    const cfg = getConfig();

    switch (name) {
        // upstream Desktop Commander tools
        case 'start_process': if (args.command) cmds.push(String(args.command)); break;
        case 'interact_with_process': if (args.input) cmds.push(String(args.input)); break;
        case 'read_file': if (!args.isUrl) reads.push(args.path); break;
        case 'read_multiple_files': reads.push(...(Array.isArray(args.paths) ? args.paths : [])); break;
        case 'list_directory': case 'get_file_info': case 'start_search': reads.push(args.path); break;
        case 'write_file': case 'write_pdf': case 'create_directory': writes.push(args.path); break;
        case 'edit_block': writes.push(args.file_path); break;
        case 'move_file': writes.push(args.source, args.destination); break;
        case 'set_config_value':
            if (!SAFE_CONFIG_KEYS.has(String(args.key))) results.push({ decision: 'approval', reasons: [`changes server config "${args.key}"`] });
            break;
        case 'kill_process':
            if (cfg.security.profile === 'strict') results.push({ decision: 'approval', reasons: ['strict profile: killing processes'] });
            break;
        // OpenCommander tools
        case 'job_start':
            if (args.command) cmds.push(String(args.command));
            for (const s of Array.isArray(args.steps) ? args.steps : []) if (s?.command) cmds.push(String(s.command));
            writes.push(args.cwd);
            break;
        case 'test_run': case 'lint_run': case 'build_run': case 'repo_verify':
            if (args.command) cmds.push(String(args.command));
            if (args.args) cmds.push(String(args.args));
            if (args.test_args) cmds.push(String(args.test_args));
            for (const s of Array.isArray(args.steps) ? args.steps : []) if (s?.command) cmds.push(String(s.command));
            writes.push(args.path);
            break;
        case 'patch_apply': case 'git_rollback': case 'git_checkpoint': writes.push(args.path); break;
        case 'patch_preview': case 'repo_status': case 'repo_diff': case 'repo_overview': case 'repo_find_symbol':
        case 'repo_search': case 'git_checkpoint_list':
            reads.push(args.path); break;
        case 'repo_outline': case 'repo_related': reads.push(args.file); break;
        case 'read_ranges': for (const it of Array.isArray(args.items) ? args.items : []) reads.push(it?.path); break;
        case 'session_start': if (args.path) reads.push(args.path); break;
    }

    for (const c of cmds) results.push(classifyCommand(c));
    for (const p of reads) if (p) results.push(checkPath(String(p), 'read'));
    for (const p of writes) if (p) results.push(checkPath(String(p), 'write'));

    // Never let a redacted secret be written back over the real value.
    const writeContent = [args.content, args.new_string, args.patch].filter(v => typeof v === 'string');
    if ((name === 'write_file' || name === 'edit_block' || name === 'patch_apply') && writeContent.some(containsMask)) {
        results.push({ decision: 'deny', reasons: [`content contains the redaction marker "${MASK_MARKER}…]" — that is a masked secret, not the real value. Edit around it instead of rewriting it.`] });
    }

    const summaryParts = [
        ...cmds.map(c => `$ ${c}`),
        ...writes.filter(Boolean).map(p => `write ${p}`),
        ...reads.filter(Boolean).slice(0, 5).map(p => `read ${p}`),
    ];
    if (name === 'set_config_value') summaryParts.push(`${args.key} = ${JSON.stringify(args.value)}`);
    return { policy: merge(results), summary: `${name}: ${summaryParts.join(' | ') || JSON.stringify(args).slice(0, 300)}` };
}

function applyHttpClamps(name: string, args: Record<string, any>): void {
    if (currentTransport() !== 'http') return;
    const max = getConfig().http.max_sync_wait_ms;
    if ((name === 'start_process' || name === 'interact_with_process' || name === 'read_process_output') && typeof args.timeout_ms === 'number' && args.timeout_ms > max) {
        args.timeout_ms = max;
        args.__oc_clamped = true;
    }
}

function postProcess(result: AnyResult, name: string): AnyResult {
    const cfg = getConfig();
    if (!result || !Array.isArray(result.content)) return result;
    let masked = 0;
    const kinds = new Set<string>();
    for (const c of result.content) {
        if (c.type !== 'text' || typeof c.text !== 'string') continue;
        if (cfg.security.mask_secrets) {
            const m = maskSecrets(c.text);
            if (m.count) { masked += m.count; m.kinds.forEach(k => kinds.add(k)); c.text = m.text; }
        }
        if (c.text.length > cfg.output.max_tool_output_chars) {
            c.text = truncateMiddle(c.text, cfg.output.max_tool_output_chars) +
                `\n[OpenCommander: output truncated to ${cfg.output.max_tool_output_chars} chars. Use offsets/grep/read_ranges to see specific parts.]`;
        }
    }
    if (masked) {
        result.content.push({ type: 'text', text: `[OpenCommander: ${masked} secret value(s) masked (${[...kinds].join(', ')}). Do not write "${MASK_MARKER}…]" back into files.]` });
    }
    return result;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | '__oc_timeout__'> {
    let t: NodeJS.Timeout;
    return Promise.race([
        p.finally(() => clearTimeout(t)),
        new Promise<'__oc_timeout__'>(r => { t = setTimeout(() => r('__oc_timeout__'), ms); }),
    ]);
}

/**
 * Wrap a tool call. `delegate` runs an upstream Desktop Commander tool.
 */
export async function guardedCall(name: string, rawArgs: unknown, delegate: (args: Record<string, unknown>) => Promise<AnyResult>): Promise<AnyResult> {
    const started = Date.now();
    const args: Record<string, any> = rawArgs && typeof rawArgs === 'object' ? { ...(rawArgs as Record<string, unknown>) } : {};
    const approvalId = typeof args.approval_id === 'string' ? args.approval_id : undefined;
    const transport = currentTransport();
    const argsForFingerprint = { ...args };
    delete argsForFingerprint.approval_id;

    const { policy, summary } = evaluate(name, args);

    if (policy.decision === 'deny') {
        audit({ tool: name, args: argsForFingerprint, decision: 'deny', reasons: policy.reasons, transport, is_error: true });
        return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'DENIED', tool: name, reasons: policy.reasons, note: 'Blocked by OpenCommander security policy. Do not try to work around it; tell the user what you wanted to do and why.' }, null, 1) }],
            isError: true,
        };
    }

    if (policy.decision === 'approval') {
        if (!approvalId) {
            const apr = requestApproval(name, argsForFingerprint, policy.reasons, summary);
            audit({ tool: name, args: argsForFingerprint, decision: 'approval_required', reasons: policy.reasons, approval_id: apr.id, transport });
            const port = ((global as any).__ocAdminPort || getConfig().http.admin_port);
            try { process.stderr.write(`\n  >>> APPROVAL NEEDED ${apr.id}: ${summary.slice(0, 200)}\n      reasons: ${policy.reasons.join('; ')}\n      approve: http://127.0.0.1:${port}/  or  opencommander approve ${apr.id}\n\n`); } catch { /* ignore */ }
            return {
                content: [{
                    type: 'text', text: JSON.stringify({
                        status: 'APPROVAL_REQUIRED',
                        approval_id: apr.id,
                        reasons: policy.reasons,
                        action: summary,
                        ask_user: `Please approve "${apr.id}" in the OpenCommander dashboard http://127.0.0.1:${port}/ (on the PC running OpenCommander) or run: opencommander approve ${apr.id}`,
                        then: `After the user confirms, call ${name} again with the SAME arguments plus approval_id="${apr.id}". You can check with approval_status("${apr.id}").`,
                    }, null, 1),
                }],
            };
        }
        const c = consume(approvalId, name, argsForFingerprint);
        if (!c.ok) {
            audit({ tool: name, args: argsForFingerprint, decision: `approval_${c.status}`, approval_id: approvalId, transport, is_error: true });
            return { content: [{ type: 'text', text: JSON.stringify({ status: c.status === 'pending' ? 'APPROVAL_PENDING' : 'APPROVAL_INVALID', approval_id: approvalId, message: c.message }, null, 1) }], isError: c.status !== 'pending' };
        }
    }

    delete args.approval_id;
    applyHttpClamps(name, args);
    const clamped = !!args.__oc_clamped;
    delete args.__oc_clamped;

    const cfg = getConfig();
    const exec = OC_TOOL_NAMES.has(name) ? callOcTool(name, args) as Promise<AnyResult> : delegate(args);
    let result: AnyResult;
    if (transport === 'http') {
        const r = await withTimeout(exec, cfg.http.tool_call_timeout_seconds * 1000);
        result = r === '__oc_timeout__'
            ? { content: [{ type: 'text', text: JSON.stringify({ status: 'STILL_RUNNING_IN_BACKGROUND', tool: name, note: `This call exceeded ${cfg.http.tool_call_timeout_seconds}s so OpenCommander answered early to avoid a ChatGPT timeout. For long operations use job_start + job_wait instead.` }) }], isError: true }
            : r;
    } else {
        result = await exec;
    }
    if (clamped && result?.content) {
        result.content.push({ type: 'text', text: `[OpenCommander: timeout_ms clamped to ${cfg.http.max_sync_wait_ms} ms to stay under the ChatGPT tool timeout. The process keeps running — use read_process_output, or job_start for long work.]` });
    }
    result = postProcess(result, name);
    const preview = result?.content?.find(c => c.type === 'text')?.text?.slice(0, 300);
    audit({ tool: name, args: argsForFingerprint, decision: policy.decision === 'approval' ? 'approved' : 'allow', approval_id: approvalId, transport, is_error: !!result?.isError, duration_ms: Date.now() - started, result_preview: preview });
    return result;
}
