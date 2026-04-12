import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface SafeExecOptions {
  timeout?: number;
  maxBuffer?: number;
}

const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024; // 50MB

/**
 * Execute a command safely using execFile (no shell interpolation).
 * Prevents command injection by passing arguments as an array.
 */
export async function safeExec(
  command: string,
  args: string[],
  options?: SafeExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    timeout: options?.timeout ? options.timeout * 1000 : undefined,
    maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
  });
}
