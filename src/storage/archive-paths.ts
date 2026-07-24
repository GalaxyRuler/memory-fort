/**
 * Archive and operational paths are never live user data. Treat every path
 * component case-insensitively, including a final file name such as
 * `raw/.retained.md`, so Windows callers cannot bypass the archive fence.
 * `_archive` is the dashboard maintenance archive destination; it stays an
 * exact canonical component rather than a broad substring rule.
 */
export function hasArchiveOrSystemPathComponent(relPath: string): boolean {
  return relPath
    .replace(/\\/g, "/")
    .split("/")
    .some((component) => {
      const normalized = component.toLowerCase();
      return normalized === "archive" || normalized === "_archive" || normalized.startsWith(".");
    });
}

/**
 * Ripgrep callers pair these with `--glob-case-insensitive` so physical
 * traversal follows the same Windows-safe component policy as the predicate.
 */
export const ARCHIVE_OR_SYSTEM_RIPGREP_EXCLUSION_GLOBS = [
  "!**/archive/**",
  "!**/_archive/**",
  "!**/.*",
  "!**/.*/**",
] as const;
