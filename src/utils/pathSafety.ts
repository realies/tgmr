import { resolve } from 'path';

/**
 * Validates that a file path resolves to a location within the allowed base directory.
 * Prevents path traversal attacks from external tool output.
 * Returns the resolved absolute path if safe, throws otherwise.
 */
export function assertSafePath(filePath: string, baseDir: string): string {
  const resolved = resolve(filePath);
  const base = resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + '/')) {
    throw new Error(`Path traversal detected: ${filePath} is outside ${baseDir}`);
  }
  return resolved;
}
