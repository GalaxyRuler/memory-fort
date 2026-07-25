/**
 * Archive and operational paths are never live user data. Treat every path
 * component case-insensitively, including a final file name such as
 * `raw/.retained.md`, so Windows callers cannot bypass the archive fence.
 * `_archive` is the dashboard maintenance archive destination; it stays an
 * exact canonical component rather than a broad substring rule.
 */
export function hasArchiveOrSystemPathComponent(relPath: string): boolean {
  return hasArchivePathComponent(relPath) || hasSystemPathComponent(relPath);
}

export function hasArchivePathComponent(relPath: string): boolean {
  return pathComponents(relPath).some((component) => component === "archive" || component === "_archive");
}

export function hasSystemPathComponent(relPath: string): boolean {
  return pathComponents(relPath).some((component) => component.startsWith("."));
}

function pathComponents(relPath: string): string[] {
  return relPath
    .replace(/\\/g, "/")
    .split("/")
    .map((component) => component.toLowerCase());
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
