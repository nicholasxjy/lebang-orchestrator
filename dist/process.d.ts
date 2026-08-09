export interface ProcessResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    aborted: boolean;
}
export interface ProcessOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}
export declare function runProcess(command: readonly string[], cwd: string, options?: ProcessOptions): Promise<ProcessResult>;
