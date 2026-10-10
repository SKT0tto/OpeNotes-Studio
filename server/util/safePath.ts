import path from 'node:path';

/**
 * Resolve `rel` under `root`. Returns the absolute path, or null when the result
 * would escape `root` (path traversal), or `rel` contains NUL / a drive prefix.
 */
export function resolveInside(root: string, rel: string): string | null {
  if (rel.includes('\0')) return null;
  const normalized = rel.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, normalized);
  if (abs === base) return abs;
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return abs.startsWith(prefix) ? abs : null;
}
