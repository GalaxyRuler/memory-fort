import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runPrune } from "../../../src/cli/commands/prune.js";
import {
  loadEmbeddings,
  saveEmbeddings,
} from "../../../src/retrieval/embeddings-store.js";
import { loadSearchCorpus } from "../../../src/retrieval/corpus.js";

describe("runPrune", () => {
  let tmp: string;
  let root: string;
  let previousMemoryRoot: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "prune-"));
    root = join(tmp, ".memory");
    previousMemoryRoot = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = root;
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    if (previousMemoryRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = previousMemoryRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  it("--plan reports eligible wiki and raw candidates without moving files", async () => {
    await seedPruneVault();

    const result = await runPrune({
      mode: "plan",
      now: new Date("2026-05-24T00:00:00.000Z"),
    });

    expect(result.candidates.map((candidate) => candidate.path).sort()).toEqual([
      "raw/2025-01-01/codex-old.md",
      "wiki/projects/eligible.md",
    ]);
    expect(result.report).toContain("stale-orphan-low-confidence");
    expect(result.report).toContain("large-raw");
    expect(existsSync(join(root, "wiki", "projects", "eligible.md"))).toBe(true);
    expect(existsSync(join(root, "wiki", "archive"))).toBe(false);
  });

  it("--apply archives candidates and --restore moves a page back", async () => {
    await seedPruneVault();
    await saveEmbeddings(root, "wiki", [
      embedding("wiki/projects/eligible.md"),
      embedding("wiki/projects/keep.md"),
    ]);
    await saveEmbeddings(root, "raw", [embedding("raw/2025-01-01/codex-old.md")]);

    const applied = await runPrune({
      mode: "apply",
      now: new Date("2026-05-24T00:00:00.000Z"),
    });

    expect(applied.moved.map((item) => item.to).sort()).toEqual([
      "wiki/archive/2026-05-24/raw/2025-01-01/codex-old.md",
      "wiki/archive/2026-05-24/wiki/projects/eligible.md",
    ]);
    expect(existsSync(join(root, "wiki", "projects", "eligible.md"))).toBe(false);
    expect(
      existsSync(
        join(root, "wiki", "archive", "2026-05-24", "wiki", "projects", "eligible.md"),
      ),
    ).toBe(true);

    const wikiEmbeddings = await loadEmbeddings(root, "wiki");
    expect(
      wikiEmbeddings.records.find((record) => record.path === "wiki/projects/eligible.md")
        ?.archived,
    ).toBe(true);
    const corpus = await loadSearchCorpus({ vaultRoot: root, scope: "wiki" });
    expect(corpus.documents.map((document) => document.relPath)).not.toContain(
      "wiki/archive/2026-05-24/wiki/projects/eligible.md",
    );

    const restored = await runPrune({
      mode: "restore",
      path: "wiki/archive/2026-05-24/wiki/projects/eligible.md",
    });
    expect(restored.restored).toEqual({
      from: "wiki/archive/2026-05-24/wiki/projects/eligible.md",
      to: "wiki/projects/eligible.md",
    });
    expect(await readFile(join(root, "wiki", "projects", "eligible.md"), "utf-8"))
      .toContain("Eligible body");
    expect(
      (await loadEmbeddings(root, "wiki")).records.find(
        (record) => record.path === "wiki/projects/eligible.md",
      )?.archived,
    ).toBe(false);

    const replanned = await runPrune({
      mode: "plan",
      now: new Date("2026-05-24T00:00:00.000Z"),
    });
    expect(replanned.candidates.map((candidate) => candidate.path)).toContain(
      "wiki/projects/eligible.md",
    );
  });

  it("--plan honors retention.raw_window_days from config", async () => {
    await writeFile(
      join(root, "config.yaml"),
      ["retention:", "  raw_window_days: 30", ""].join("\n"),
    );
    await writeRaw("2026-04-15/codex-forty-days.md", "Forty days old.");

    const result = await runPrune({
      mode: "plan",
      now: new Date("2026-05-24T00:00:00.000Z"),
    });

    expect(result.candidates.map((candidate) => candidate.path)).toContain(
      "raw/2026-04-15/codex-forty-days.md",
    );
  });

  it("--plan defaults raw retention to 90 days when config is unset", async () => {
    await writeRaw("2026-04-15/codex-forty-days.md", "Forty days old.");

    const result = await runPrune({
      mode: "plan",
      now: new Date("2026-05-24T00:00:00.000Z"),
    });

    expect(result.candidates.map((candidate) => candidate.path)).not.toContain(
      "raw/2026-04-15/codex-forty-days.md",
    );
  });

  async function seedPruneVault(): Promise<void> {
    await writeWikiPage(
      "projects/eligible.md",
      {
        type: "projects",
        title: "Eligible",
        created: "2025-01-01",
        updated: "2025-01-01",
        status: "active",
        confidence: 0.3,
      },
      "Eligible body.",
    );
    await writeWikiPage(
      "projects/keep.md",
      {
        type: "projects",
        title: "Keep",
        created: "2025-01-01",
        updated: "2025-01-01",
        status: "active",
        confidence: 0.9,
      },
      "Keep body references raw/2025-01-01/codex-referenced.md.",
    );
    await writeRaw("2025-01-01/codex-old.md", "Old raw body.");
    await writeRaw("2025-01-01/codex-referenced.md", "Referenced raw body.");
    await writeRaw("2026-05-01/codex-recent.md", "Recent raw body.");
  }

  async function writeWikiPage(
    relPath: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void> {
    const full = join(root, "wiki", relPath);
    await mkdir(dirname(full), { recursive: true });
    const yaml = Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n");
    await writeFile(full, `---\n${yaml}\n---\n\n${body}\n`);
  }

  async function writeRaw(relPath: string, body: string): Promise<void> {
    const full = join(root, "raw", relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }
});

function embedding(path: string) {
  return {
    path,
    hash: `hash-${path}`,
    vector: [1, 0, 1],
    model: "test",
    dim: 3,
    ts: "2026-05-24T00:00:00.000Z",
  };
}
