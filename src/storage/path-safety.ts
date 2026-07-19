import { isAbsolute, relative, resolve } from "node:path";

/** Single path segment: letters, digits, dot, underscore, hyphen only. */
export const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * True when `child` resolves strictly under `parent` (not equal, not outside).
 * Uses path.relative so Windows drive / root-absolute segments cannot escape.
 */
export function isStrictChild(parent: string, child: string): boolean {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  const rel = relative(parentResolved, childResolved);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Reject inputs that are absolute, drive-qualified, or use unsafe segments
 * before any join. Returns normalized relative segments or null.
 */
export function parseSafeRelativeSegments(relativePath: string): string[] | null {
  if (typeof relativePath !== "string" || relativePath.length === 0) return null;
  if (relativePath.includes("\0")) return null;

  // Explicit absolute / drive checks (including lowercase Windows drives).
  if (isAbsolute(relativePath)) return null;
  if (/^[a-zA-Z]:[\\/]/.test(relativePath)) return null;
  if (relativePath.startsWith("/") || relativePath.startsWith("\\")) return null;
  if (relativePath.includes("..")) return null;

  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;

  for (const segment of segments) {
    if (segment === "." || segment === "..") return null;
    if (!SAFE_SEGMENT_RE.test(segment)) return null;
  }
  return segments;
}

/**
 * Resolve `relativePath` under `parent` only if every segment is safe and the
 * final path is a strict child of `parent`. Returns the absolute path or null.
 */
export function resolveStrictChild(parent: string, relativePath: string): string | null {
  const segments = parseSafeRelativeSegments(relativePath);
  if (segments === null) return null;
  const full = resolve(parent, ...segments);
  return isStrictChild(parent, full) ? full : null;
}
