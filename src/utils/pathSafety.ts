import { isAbsolute, relative, resolve } from 'path';

/**
 * Validates that a file path resolves to a location within the allowed base directory.
 * Uses path.relative for cross-platform safety (works on both POSIX and Windows).
 * Returns the resolved absolute path if safe, throws otherwise.
 */
export function assertSafePath(filePath: string, baseDir: string): string {
  const resolved = resolve(filePath);
  const base = resolve(baseDir);
  const rel = relative(base, resolved);
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`Path traversal detected: ${filePath} is outside ${baseDir}`);
  }
  return resolved;
}
