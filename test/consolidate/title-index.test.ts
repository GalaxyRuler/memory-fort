import { describe, expect, it } from "vitest";
import {
  buildTitleIndex,
  findTitleMentions,
} from "../../src/consolidate/title-index.js";
import type { SearchDocument } from "../../src/retrieval/corpus.js";

describe("title consolidation index", () => {
  it("finds exact title and alias mentions case-insensitively", () => {
    const index = buildTitleIndex([
      wiki("wiki/decisions/voyage-ai-for-embeddings.md", "Voyage AI for embeddings", ["Voyage embeddings"]),
      wiki("wiki/projects/memory-fort.md", "Memory Fort"),
      wiki("wiki/tools/codex-cli.md", "Codex CLI"),
      wiki("wiki/lessons/graph-edge-hygiene.md", "Graph edge hygiene"),
      wiki("wiki/references/karpathy-llm-wiki-pattern.md", "Karpathy LLM wiki pattern"),
      wiki("wiki/people/andrej-karpathy.md", "Andrej Karpathy"),
      wiki("wiki/decisions/bm25-hybrid-retrieval.md", "BM25 hybrid retrieval"),
      wiki("wiki/tools/vitest.md", "Vitest"),
      wiki("wiki/references/test.md", "Test"),
      wiki("wiki/references/2026.md", "2026"),
    ]);

    const matches = findTitleMentions(
      "We tuned voyage embeddings inside Memory Fort and checked codex cli.",
      index,
    );

    expect(matches.map((match) => match.relPath)).toEqual([
      "wiki/decisions/voyage-ai-for-embeddings.md",
      "wiki/projects/memory-fort.md",
      "wiki/tools/codex-cli.md",
    ]);
    expect(matches[0]).toMatchObject({
      title: "Voyage embeddings",
      confidence: 1,
    });
  });

  it("finds partial title-prefix mentions at lower confidence", () => {
    const index = buildTitleIndex([
      wiki("wiki/decisions/voyage-ai-for-embeddings.md", "Voyage AI for embeddings"),
      wiki("wiki/decisions/bm25-hybrid-retrieval.md", "BM25 hybrid retrieval"),
      wiki("wiki/projects/memory-fort.md", "Memory Fort"),
      wiki("wiki/tools/codex-cli.md", "Codex CLI"),
      wiki("wiki/lessons/graph-edge-hygiene.md", "Graph edge hygiene"),
      wiki("wiki/references/karpathy-llm-wiki-pattern.md", "Karpathy LLM wiki pattern"),
      wiki("wiki/people/andrej-karpathy.md", "Andrej Karpathy"),
      wiki("wiki/tools/vitest.md", "Vitest"),
      wiki("wiki/references/test.md", "Test"),
      wiki("wiki/references/2026.md", "2026"),
    ]);

    const matches = findTitleMentions(
      "The Voyage AI decision shaped the retrieval path.",
      index,
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      relPath: "wiki/decisions/voyage-ai-for-embeddings.md",
      title: "Voyage AI",
      confidence: 0.85,
    });
  });

  it("excludes short, numeric, and single stopword titles", () => {
    const index = buildTitleIndex([
      wiki("wiki/references/test.md", "Test"),
      wiki("wiki/references/2026.md", "2026"),
      wiki("wiki/references/ai.md", "AI"),
      wiki("wiki/tools/vitest.md", "Vitest"),
    ]);

    const matches = findTitleMentions(
      "A test in 2026 used AI and Vitest together.",
      index,
    );

    expect(matches.map((match) => match.relPath)).toEqual([
      "wiki/tools/vitest.md",
    ]);
  });

  it("excludes audit logs from title matching targets", () => {
    const index = buildTitleIndex([
      wiki("wiki/.audit/consolidate-2026-05-27.md", "consolidate audit"),
      wiki("wiki/projects/memory-fort.md", "Memory Fort"),
    ]);

    const matches = findTitleMentions(
      "The consolidate audit mentioned Memory Fort.",
      index,
    );

    expect(matches.map((match) => match.relPath)).toEqual([
      "wiki/projects/memory-fort.md",
    ]);
  });

  it("deduplicates repeated hits by page and keeps the earliest position", () => {
    const index = buildTitleIndex([
      wiki("wiki/projects/memory-fort.md", "Memory Fort"),
    ]);

    const matches = findTitleMentions(
      "Memory Fort work made memory fort easier to inspect.",
      index,
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      relPath: "wiki/projects/memory-fort.md",
      position: 0,
    });
  });
});

function wiki(
  relPath: string,
  title: string,
  aliases: string[] = [],
): SearchDocument {
  return {
    kind: "wiki",
    relPath,
    fullPath: relPath,
    title,
    type: relPath.split("/")[1] ?? "references",
    status: "active",
    cognitiveType: "semantic",
    confidence: null,
    tags: [],
    relations: {},
    source: "unknown",
    session: null,
    importedFrom: null,
    body: "",
    snippetSource: "",
    created: null,
    observedAt: null,
    updated: null,
    mtime: "2026-05-27T00:00:00.000Z",
    sizeBytes: 0,
    rawFrontmatter: aliases.length > 0 ? { aliases } : null,
  };
}
