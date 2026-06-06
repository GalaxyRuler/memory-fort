import { basename, dirname, extname } from "node:path";

export function kebabCase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeWikiPagePath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const ext = extname(normalized);
  if (ext !== ".md") return normalized;

  const slug = kebabCase(basename(normalized, ext));
  if (!slug) return normalized;

  return `${dirname(normalized).replace(/\\/g, "/")}/${slug}.md`;
}
