import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoLinkRawToWiki } from "../../src/capture/auto-link.js";
import { saveEmbeddings, type EmbeddingKind, type EmbeddingRecord } from "../../src/retrieval/embeddings-store.js";
import { parseFrontmatter } from "../../src/storage/frontmatter.js";

describe("autoLinkRawToWiki", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "auto-link-"));
    await writeMarkdown(
      "wiki/projects/memory-system.md",
      page("projects", "Memory System", "Memory System project page for graph coverage hooks."),
    );
    await writeMarkdown(
      "wiki/tools/vitest.md",
      page("tools", "Vitest", "Vitest test runner."),
    );
    await writeMarkdown(
      "raw/2026-06-03/codex-1.md",
      rawPage("Codex session", "We implemented Memory System graph coverage with hooks."),
    );
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes a mentions edge when raw and wiki sidecar embeddings are above threshold", async () => {
    await saveEmbeddings(tmp, "wiki", [
      embedding("wiki/projects/memory-system.md", vector(0)),
      embedding("wiki/tools/vitest.md", vector(1)),
    ]);
    await saveEmbeddings(tmp, "raw", [
      embedding("raw/2026-06-03/codex-1.md", vector(0, 0.98, { 1: 0.02 })),
    ]);

    const result = await autoLinkRawToWiki("raw/2026-06-03/codex-1.md", {
      vaultRoot: tmp,
      threshold: 0.75,
      apply: true,
      now: new Date("2026-06-03T10:00:00.000Z"),
    });

    expect(result.skipped).toBe(false);
    expect(result.linked).toEqual([
      expect.objectContaining({
        target: "wiki/projects/memory-system.md",
        strategy: "embedding",
      }),
    ]);
    const parsed = parseFrontmatter(await readFile(join(tmp, "raw", "2026-06-03", "codex-1.md"), "utf-8"));
    expect(parsed.frontmatter.relations?.mentions).toEqual([
      expect.objectContaining({
        target: "wiki/projects/memory-system.md",
        confidence: expect.any(Number),
        source: {
          agent: "auto-link",
          session_id: "codex-1",
          captured_at: "2026-06-03T10:00:00.000Z",
        },
      }),
    ]);
  });

  it("does not write a relation when the best embedding match is below threshold", async () => {
    await saveEmbeddings(tmp, "wiki", [
      embedding("wiki/projects/memory-system.md", vector(0)),
    ]);
    await saveEmbeddings(tmp, "raw", [
      embedding("raw/2026-06-03/codex-1.md", vector(1)),
    ]);

    const result = await autoLinkRawToWiki("raw/2026-06-03/codex-1.md", {
      vaultRoot: tmp,
      threshold: 0.75,
      apply: true,
    });

    expect(result.linked).toEqual([]);
    const parsed = parseFrontmatter(await readFile(join(tmp, "raw", "2026-06-03", "codex-1.md"), "utf-8"));
    expect(parsed.frontmatter.relations).toBeUndefined();
  });

  it("falls back to title matching when embeddings are unavailable", async () => {
    const result = await autoLinkRawToWiki("raw/2026-06-03/codex-1.md", {
      vaultRoot: tmp,
      threshold: 0.75,
      apply: true,
    });

    expect(result.linked).toEqual([
      expect.objectContaining({
        target: "wiki/projects/memory-system.md",
        strategy: "title",
      }),
    ]);
  });

  it("refuses degenerate stub embeddings and falls back to title matching", async () => {
    await writeEmbeddingSidecar("wiki", [
      embedding("wiki/projects/memory-system.md", [1, 0, 0]),
      embedding("wiki/tools/vitest.md", [1, 0, 0]),
    ]);
    await writeEmbeddingSidecar("raw", [
      embedding("raw/2026-06-03/codex-1.md", [1, 0, 0]),
    ]);

    const result = await autoLinkRawToWiki("raw/2026-06-03/codex-1.md", {
      vaultRoot: tmp,
      threshold: 0.75,
      titleThreshold: 0.6,
      expectedEmbeddingDim: 2048,
      apply: true,
    });

    expect(result.linked).toEqual([
      expect.objectContaining({
        target: "wiki/projects/memory-system.md",
        strategy: "title",
      }),
    ]);
    expect(result.linked).not.toContainEqual(expect.objectContaining({ strategy: "embedding" }));
  });

  it("skips without writing when degenerate embeddings have no lexical fallback", async () => {
    await writeMarkdown(
      "raw/2026-06-03/codex-1.md",
      rawPage("Unrelated session", "The transcript discusses shell quoting and no known entity title."),
    );
    await writeEmbeddingSidecar("wiki", [
      embedding("wiki/projects/memory-system.md", [1, 0, 0]),
      embedding("wiki/tools/vitest.md", [1, 0, 0]),
    ]);
    await writeEmbeddingSidecar("raw", [
      embedding("raw/2026-06-03/codex-1.md", [1, 0, 0]),
    ]);

    const result = await autoLinkRawToWiki("raw/2026-06-03/codex-1.md", {
      vaultRoot: tmp,
      threshold: 0.75,
      titleThreshold: 0.6,
      expectedEmbeddingDim: 2048,
      apply: true,
    });

    expect(result.linked).toEqual([]);
    expect(result.reason).toBe("degenerate embeddings");
    const parsed = parseFrontmatter(await readFile(join(tmp, "raw", "2026-06-03", "codex-1.md"), "utf-8"));
    expect(parsed.frontmatter.relations).toBeUndefined();
  });

  it("keeps the degenerate embedding guard effective at the lowered default threshold", async () => {
    await writeMarkdown(
      "raw/2026-06-03/codex-1.md",
      rawPage("Unrelated session", "The transcript discusses shell quoting and no known entity title."),
    );
    await writeEmbeddingSidecar("wiki", [
      embedding("wiki/projects/memory-system.md", [1, 0, 0]),
      embedding("wiki/tools/vitest.md", [1, 0, 0]),
    ]);
    await writeEmbeddingSidecar("raw", [
      embedding("raw/2026-06-03/codex-1.md", [1, 0, 0]),
    ]);

    const result = await autoLinkRawToWiki("raw/2026-06-03/codex-1.md", {
      vaultRoot: tmp,
      expectedEmbeddingDim: 2048,
      apply: true,
    });

    expect(result.linked).toEqual([]);
    expect(result.reason).toBe("degenerate embeddings");
    const parsed = parseFrontmatter(await readFile(join(tmp, "raw", "2026-06-03", "codex-1.md"), "utf-8"));
    expect(parsed.frontmatter.relations).toBeUndefined();
  });

  it("does not title-link on shared generic support and date tokens alone", async () => {
    await resetFixture();
    await writeMarkdown(
      "wiki/decisions/2026-05-22-curation-orchestrator-not-llm.md",
      page("decisions", "2026-05-22 Curation Orchestrator Not LLM", "Memory code file system session summary."),
    );
    await writeMarkdown(
      "raw/2026-06-03/codex-1.md",
      rawPage(
        "Codex session 2026-05-22",
        "Memory code file system session notes from 2026 05 22. The work covered shell usage and editor state.",
      ),
    );

    const result = await autoLinkRawToWiki("raw/2026-06-03/codex-1.md", {
      vaultRoot: tmp,
      apply: true,
    });

    expect(result.linked).toEqual([]);
    const parsed = parseFrontmatter(await readFile(join(tmp, "raw", "2026-06-03", "codex-1.md"), "utf-8"));
    expect(parsed.frontmatter.relations).toBeUndefined();
  });

  it("title-links when raw text mentions distinctive candidate title terms", async () => {
    await resetFixture();
    await writeMarkdown(
      "wiki/decisions/2026-05-22-curation-orchestrator-not-llm.md",
      page("decisions", "2026-05-22 Curation Orchestrator Not LLM", "Compile policy for the curation orchestrator."),
    );
    await writeMarkdown(
      "raw/2026-06-03/codex-1.md",
      rawPage(
        "Curation fix",
        "We changed the curation orchestrator compile path so routing is deterministic and LLM choice stays out of it.",
      ),
    );

    const result = await autoLinkRawToWiki("raw/2026-06-03/codex-1.md", {
      vaultRoot: tmp,
      titleThreshold: 0.65,
      apply: true,
    });

    expect(result.linked).toEqual([
      expect.objectContaining({
        target: "wiki/decisions/2026-05-22-curation-orchestrator-not-llm.md",
        strategy: "title",
      }),
    ]);
  });

  async function writeMarkdown(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  async function resetFixture(): Promise<void> {
    await rm(tmp, { recursive: true, force: true });
    tmp = await mkdtemp(join(tmpdir(), "auto-link-"));
  }

  async function writeEmbeddingSidecar(kind: EmbeddingKind, records: EmbeddingRecord[]): Promise<void> {
    const fullPath = join(tmp, "embeddings", `${kind}.embeddings.jsonl`);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  }
});

function embedding(path: string, vector: number[]): EmbeddingRecord {
  return {
    path,
    vector,
    hash: `hash-${path}`,
    model: "test",
    dim: vector.length,
    ts: "2026-06-03T00:00:00.000Z",
  };
}

function vector(
  primaryIndex: number,
  primaryValue = 1,
  overrides: Record<number, number> = {},
): number[] {
  const values = Array.from({ length: 16 }, () => 0);
  values[primaryIndex] = primaryValue;
  for (const [index, value] of Object.entries(overrides)) {
    values[Number(index)] = value;
  }
  return values;
}

function page(type: string, title: string, body: string): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "created: 2026-06-03",
    "updated: 2026-06-03",
    "---",
    "",
    body,
  ].join("\n");
}

function rawPage(title: string, body: string): string {
  return [
    "---",
    "type: raw-session",
    `title: ${title}`,
    "created: 2026-06-03",
    "updated: 2026-06-03",
    "session: codex-1",
    "source: codex",
    "importance: 8",
    "---",
    "",
    body,
  ].join("\n");
}
