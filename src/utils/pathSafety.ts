import { isAbsolute, relative, resolve } from 'path';

/**
 * Validates that a file path resolves to a location strictly inside the base directory.
 * Rejects paths equal to baseDir itself (only files within it are allowed).
 * Uses path.relative for cross-platform safety.
 */
export function assertSafePath(filePath: string, baseDir: string): string {
  const resolved = resolve(filePath);
  const base = resolve(baseDir);
  const rel = relative(base, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${filePath} is outside ${baseDir}`);
  }
  return resolved;
}
