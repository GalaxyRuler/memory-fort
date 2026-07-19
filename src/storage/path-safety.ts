import { isAbsolute, relative, resolve } from "node:path";

/**
 * Legacy slug-style segment pattern (letters, digits, dot, underscore, hyphen).
 * Prefer `isAllowedRelativeSegment` for vault paths — Obsidian pages often
 * include spaces and other filename-safe characters.
 */
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
 * Windows strips trailing spaces and dots from path components before resolve.
 * Normalize so `.. ` / `. ` cannot bypass exact `.` / `..` checks.
 */
export function win32NormalizeSegment(segment: string): string {
  return segment.replace(/[ .]+$/g, "");
}

/**
 * Filename segment check: block traversal and path separators / controls, but
 * allow spaces and other normal filesystem characters used by Obsidian vaults.
 */
export function isAllowedRelativeSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  // Drive-letter prefixes (C: or C:foo) — never valid vault-relative segments.
  if (/^[a-zA-Z]:/.test(segment)) return false;
  if (segment.includes("/") || segment.includes("\\")) return false;
  // C0 controls + DEL + NUL
  if (/[\u0000-\u001f\u007f]/.test(segment)) return false;

  const normalized = win32NormalizeSegment(segment);
  if (normalized.length === 0) return false;
  if (normalized === "." || normalized === "..") return false;
  // Also reject any segment that is only dots/spaces (after normalize empty).
  // Reject embedded `..` as a full segment after normalize only.
  return true;
}

/**
 * Reject inputs that are absolute, drive-qualified, or unsafe before any join.
 * Returns normalized relative segments or null.
 *
 * Containment is finalized by `resolve` + `isStrictChild` in resolveStrictChild.
 */
export function parseSafeRelativeSegments(relativePath: string): string[] | null {
  if (typeof relativePath !== "string" || relativePath.length === 0) return null;
  if (relativePath.includes("\0")) return null;

  // Explicit absolute / drive checks (including lowercase Windows drives).
  // Also reject drive-relative forms like "C:tools/git.md" (no slash after
  // the colon) — path.resolve treats those as cwd-on-drive, not vault-relative.
  if (isAbsolute(relativePath)) return null;
  if (/^[a-zA-Z]:/.test(relativePath)) return null;
  if (relativePath.startsWith("/") || relativePath.startsWith("\\")) return null;

  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;

  for (const segment of segments) {
    if (!isAllowedRelativeSegment(segment)) return null;
    // Explicit: ".." must never pass even if we loosen other rules later.
    if (segment === "..") return null;
    // Reject drive-letter prefixes inside any segment (C:foo).
    if (/^[a-zA-Z]:/.test(segment)) return null;
  }
  // Reject any remaining ".." substring that is a whole segment only —
  // `foo/../bar` already failed; bare `../x` failed absolute-style checks.
  if (segments.some((s) => s === "..")) return null;
  return segments;
}

/**
 * Resolve `relativePath` under `parent` only if every segment is allowed and
 * the final path is a strict child of `parent`. Returns the absolute path or null.
 */
export function resolveStrictChild(parent: string, relativePath: string): string | null {
  const segments = parseSafeRelativeSegments(relativePath);
  if (segments === null) return null;
  const full = resolve(parent, ...segments);
  return isStrictChild(parent, full) ? full : null;
}
