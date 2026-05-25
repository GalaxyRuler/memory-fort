import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSearchCorpus } from "../../src/retrieval/corpus.js";
import type { EmbedClient } from "../../src/retrieval/refresh.js";
import { runSearch } from "../../src/retrieval/search.js";
import type { VoyageClient } from "../../src/retrieval/voyage-client.js";

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "cross-agent",
);

describe("cross-agent raw memory canonicalization", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "cross-agent-"));
    await cp(fixtureRoot, tmp, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("normalizes Claude, Codex, and Antigravity raw observations into one corpus shape", async () => {
    const result = await loadSearchCorpus({ vaultRoot: tmp, scope: "raw" });

    expect(result.errors).toEqual([]);
    expect(result.documents).toHaveLength(3);
    expect(result.documents.map((document) => document.source).sort()).toEqual([
      "antigravity",
      "claude-code",
      "codex",
    ]);
    expect(result.documents.map((document) => document.agentSessionId).sort()).toEqual([
      "antigravity-session-3",
      "claude-session-1",
      "codex-session-2",
    ]);
    expect(
      result.documents.every((document) =>
        document.topicTags?.includes("graphcanvas"),
      ),
    ).toBe(true);
    expect(
      result.documents.flatMap((document) => document.toolCallsSummary ?? []),
    ).toEqual(
      expect.arrayContaining([
        "apply_patch",
        "browser",
        "edit src/dashboard-ui/components/GraphCanvas.tsx",
      ]),
    );
  });

  it("retrieves the same topic across agent-specific raw formats", async () => {
    const { embedClient, voyageClient } = clients();

    const response = await runSearch({
      query: "GraphCanvas resize fix",
      scope: "raw",
      k: 5,
      noRerank: true,
      noHyde: true,
      vaultRoot: tmp,
      embedClient,
      voyageClient,
    });

    expect(response.results.map((result) => result.path).sort()).toEqual([
      "raw/2026-05-24/antigravity-ag789.md",
      "raw/2026-05-24/claude-code-claude123.md",
      "raw/2026-05-24/codex-codex456.md",
    ]);
  });
});

function clients(): {
  embedClient: EmbedClient & { embed: ReturnType<typeof vi.fn> };
  voyageClient: VoyageClient;
} {
  const embed = vi.fn(async (texts: string[]) => ({
    vectors: texts.map(vectorForText),
    model: "test-embed",
    dim: 3,
  }));

  return {
    embedClient: { embed } as EmbedClient & { embed: ReturnType<typeof vi.fn> },
    voyageClient: {
      embed,
      rerank: vi.fn(async (_query, documents) => ({
        ranked: documents.map((document, index) => ({
          index,
          score: 1 - index * 0.1,
          document,
        })),
        model: "rerank-test",
      })),
    },
  };
}

function vectorForText(text: string): number[] {
  const lower = text.toLowerCase();
  if (
    lower.includes("graphcanvas") ||
    lower.includes("resize") ||
    lower.includes("graph canvas")
  ) {
    return [1, 0, 0];
  }
  return [0, 1, 0];
}
