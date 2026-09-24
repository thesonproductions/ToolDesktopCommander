export type JobStatus =
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'timed_out'
    | 'lost';

export const TERMINAL_STATUSES: JobStatus[] = ['succeeded', 'failed', 'cancelled', 'timed_out', 'lost'];

export interface JobStep {
    name: string;
    command: string;
    /** Optional parser for this step's output (pytest, jest, generic…). */
    parser?: string;
    /** Continue with the next step even if this one fails. */
    allow_failure?: boolean;
}

export interface JobSpec {
    id: string;
    created_at: string;
    label?: string;
    cwd: string;
    shell: string;
    env?: Record<string, string>;
    steps: JobStep[];
    /** Kill the job after this many seconds (0 = no limit). */
    timeout_seconds: number;
    request_key?: string;
    /** Stop at first failing step unless the step has allow_failure. */
    continue_on_failure: boolean;
    kind: string; // 'shell' | 'test' | 'lint' | 'build' | 'verify' | …
    metadata?: Record<string, unknown>;
}

export interface StepState {
    name: string;
    command: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'timed_out';
    exit_code?: number | null;
    signal?: string | null;
    started_at?: string;
    finished_at?: string;
    duration_ms?: number;
    log_start?: number;
    log_end?: number;
}

export interface JobState {
    status: JobStatus;
    runner_pid?: number;
    pid?: number; // pid of the currently running step's process
    started_at?: string;
    heartbeat_at?: string;
    finished_at?: string;
    exit_code?: number | null;
    current_step?: number;
    steps: StepState[];
    error?: string;
    log_bytes?: number;
}
