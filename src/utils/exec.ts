import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface SafeExecOptions {
  timeout?: number;
  maxBuffer?: number;
}

const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024; // 50MB
// Backstop so stalled subprocesses don't pin a semaphore slot indefinitely.
// Callers with known-longer workloads (downloads) pass a larger explicit timeout.
const DEFAULT_TIMEOUT_SEC = 30;

/**
 * Execute a command safely using execFile (no shell interpolation).
 * Prevents command injection by passing arguments as an array.
 */
export async function safeExec(
  command: string,
  args: string[],
  options?: SafeExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  const timeoutSec = options?.timeout ?? DEFAULT_TIMEOUT_SEC;
  const maxBuffer = options?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  // Validate the resource backstops: Node treats timeout 0 as "no timeout",
  // silently disabling the stalled-subprocess kill; a non-positive maxBuffer
  // would reject all output. Fail fast instead of degrading quietly.
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new RangeError(
      `safeExec timeout must be a positive number of seconds, got: ${timeoutSec}`,
    );
  }
  if (!Number.isFinite(maxBuffer) || maxBuffer <= 0) {
    throw new RangeError(
      `safeExec maxBuffer must be a positive number of bytes, got: ${maxBuffer}`,
    );
  }
  return execFileAsync(command, args, {
    timeout: timeoutSec * 1000,
    maxBuffer,
  });
}
