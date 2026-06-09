import type { SearchDocument } from "./corpus.js";

const MAX_CONTEXT_CHARS = 500;
const MAX_BACKLINKS = 10;

export function buildContextBlock(
  doc: SearchDocument,
  backlinks: string[],
): string {
  const lines: string[] = [];

  lines.push(`# ${doc.relPath}`);

  const typeParts = [
    `Type: ${doc.type}`,
    doc.cognitiveType ? `Cognitive: ${doc.cognitiveType}` : null,
    doc.lifecycle ? `Lifecycle: ${doc.lifecycle}` : null,
  ].filter(Boolean);
  lines.push(`# ${typeParts.join(" | ")}`);

  // Relations — sorted by type then target for determinism
  const relEntries = Object.keys(doc.relations)
    .sort()
    .flatMap((type) =>
      (doc.relations[type] ?? [])
        .map((e) => e.target)
        .sort()
        .map((target) => `[[${target}]] (${type})`),
    );
  if (relEntries.length > 0) {
    lines.push(`# Relations: ${relEntries.join(", ")}`);
  }

  if (doc.tags.length > 0) {
    lines.push(`# Tags: ${[...doc.tags].sort().join(", ")}`);
  }

  if (backlinks.length > 0) {
    const sorted = [...backlinks].sort();
    const shown = sorted.slice(0, MAX_BACKLINKS);
    const overflow = sorted.length - shown.length;
    const blText = shown.map((b) => `[[${b}]]`).join(", ");
    const suffix = overflow > 0 ? ` (+${overflow} more)` : "";
    lines.push(`# Backlinks: ${blText}${suffix}`);
  }

  const block = lines.join("\n");
  if (block.length > MAX_CONTEXT_CHARS) {
    return block.slice(0, MAX_CONTEXT_CHARS);
  }
  return block;
}
