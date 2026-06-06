export function isWikiDotDirectoryPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return /^wiki\/\.[^/]+(?:\/|$)/.test(normalized);
}

export function isEntityWikiPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return normalized.startsWith("wiki/") &&
    normalized.endsWith(".md") &&
    !isWikiDotDirectoryPath(normalized);
}
