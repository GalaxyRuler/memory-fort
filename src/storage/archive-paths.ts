/**
 * Archive and operational paths are never live user data. Treat every path
 * component case-insensitively, including a final file name such as
 * `raw/.retained.md`, so Windows callers cannot bypass the archive fence.
 */
export function hasArchiveOrSystemPathComponent(relPath: string): boolean {
  return relPath
    .replace(/\\/g, "/")
    .split("/")
    .some((component) => {
      const normalized = component.toLowerCase();
      return normalized === "archive" || normalized.startsWith(".");
    });
}
