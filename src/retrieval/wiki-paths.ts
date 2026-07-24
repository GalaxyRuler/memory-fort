import { hasArchiveOrSystemPathComponent } from "../storage/archive-paths.js";

export function isWikiDotDirectoryPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return /^wiki\/\.[^/]+(?:\/|$)/.test(normalized);
}

/** Wiki archive and operational paths are never live entities. */
export function isWikiProtectedPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return normalized.startsWith("wiki/") && hasArchiveOrSystemPathComponent(normalized);
}

export function isEntityWikiPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return normalized.startsWith("wiki/") &&
    normalized.endsWith(".md") &&
    !isWikiProtectedPath(normalized);
}
