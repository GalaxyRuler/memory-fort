import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runForget } from "../../../src/cli/commands/forget.js";
import { openIndexDb, openReadOnlyIndexDb } from "../../../src/index/db.js";
import { reconcileIndex } from "../../../src/index/reconcile.js";
import { loadSearchCorpus } from "../../../src/retrieval/corpus.js";

describe("runForget", () => {
  let tmp: string;
  let root: string;
  let previousMemoryRoot: string | undefined;
  let previousIndexPath: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "forget-"));
    root = join(tmp, ".memory");
    previousMemoryRoot = process.env["MEMORY_ROOT"];
    previousIndexPath = process.env["MEMORY_INDEX_DB_PATH"];
    process.env["MEMORY_ROOT"] = root;
    process.env["MEMORY_INDEX_DB_PATH"] = join(tmp, "index.db");
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    if (previousMemoryRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = previousMemoryRoot;
    if (previousIndexPath === undefined) delete process.env["MEMORY_INDEX_DB_PATH"];
    else process.env["MEMORY_INDEX_DB_PATH"] = previousIndexPath;
    await rm(tmp, { recursive: true, force: true });
  });

  it("defaults to a non-mutating provenance plan for a canonical raw selector", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    await seedAttributableRaw(raw);
    await rebuildFixtureIndex();

    const result = await runForget({ rawPaths: [raw] });

    expect(result.mode).toBe("plan");
    expect(result.plan.raw).toEqual([raw]);
    expect(result.plan.facts).toEqual(["facts/2026-05-20/session.json"]);
    expect(result.plan.generated).toEqual(["wiki/projects/generated.md"]);
    expect(result.plan.relations).toEqual(["wiki/projects/generated.md"]);
    expect(result.plan.index.fts).toEqual([raw, "wiki/projects/generated.md"]);
    expect(result.plan.history.status).toBe("history-retained");
    expect(result.report).toContain("history-retained");
    expect(existsSync(join(root, ...raw.split("/")))).toBe(true);
  });

  it("erases only live attributable material, rebuilds the derived index, and never removes archived copies", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    await seedAttributableRaw(raw);
    await writeAt("wiki/archive/2026-05-21/raw/2026-05-20/codex-session.md", "archived secret");
    await writeAt("wiki/archive/2026-05-22/raw/2026-05-20/codex-session.md", "duplicate archived secret");
    await writeAt("raw/2026-05-20/codex-other.md", "same-size-sessio");
    await rebuildFixtureIndex();

    const result = await runForget({ mode: "apply", rawPaths: [raw] });

    expect(result.status).toBe("live-erased/history-retained");
    expect(result.erased).toEqual(expect.arrayContaining([
      raw,
      "facts/2026-05-20/session.json",
      "wiki/projects/generated.md",
    ]));
    expect(existsSync(join(root, ...raw.split("/")))).toBe(false);
    expect(existsSync(join(root, "facts", "2026-05-20", "session.json"))).toBe(false);
    expect(existsSync(join(root, "wiki", "projects", "generated.md"))).toBe(false);
    expect(await readFile(join(root, "wiki", "archive", "2026-05-21", "raw", "2026-05-20", "codex-session.md"), "utf8"))
      .toContain("archived secret");
    expect(await readFile(join(root, "wiki", "archive", "2026-05-22", "raw", "2026-05-20", "codex-session.md"), "utf8"))
      .toContain("duplicate archived secret");
    const corpus = await loadSearchCorpus({ vaultRoot: root, scope: "all" });
    expect(corpus.documents.map((document) => document.relPath)).not.toEqual(expect.arrayContaining([
      raw,
      "wiki/projects/generated.md",
    ]));
    expect(corpus.documents.map((document) => document.relPath)).toContain("raw/2026-05-20/codex-other.md");
    const index = openReadOnlyIndexDb({ vaultRoot: root });
    try {
      expect(index.database.prepare<[string], { count: number }>("SELECT count(*) AS count FROM chunks WHERE relPath = ?").get(raw)?.count)
        .toBe(0);
    } finally {
      index.close();
    }
  });

  it("blocks an ambiguous manually curated page rather than erasing a mixed page", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    await writeAt(raw, "sensitive session");
    await writeWiki(
      "projects/manual.md",
      {
        type: "projects",
        title: "Manual",
        source_facts: [raw],
        relations: { derived_from: [raw] },
      },
      "A human-curated conclusion that cannot safely be attributed block-by-block.",
    );

    const plan = await runForget({ rawPaths: [raw] });
    expect(plan.plan.blocked).toEqual(["wiki/projects/manual.md"]);
    await expect(runForget({ mode: "apply", rawPaths: [raw] }))
      .rejects.toThrow("ambiguous manual curated content");
    expect(existsSync(join(root, ...raw.split("/")))).toBe(true);
  });

  it("supports Unicode and space-bearing canonical paths and source IDs without treating crystals as erasable", async () => {
    const raw = "raw/2026-05-20/codex-session with ünicode.md";
    await writeAt(raw, "sensitive session");
    await writeAt("crystals/keep.md", "crystal references sensitive session");

    const plan = await runForget({ sourceIds: ["codex"] });

    expect(plan.plan.raw).toContain(raw);
    expect(plan.plan.crystals).toEqual(["crystals/keep.md"]);
    expect(plan.plan.erasedCrystals).toEqual([]);
    await expect(runForget({ rawPaths: ["raw/2026-05-20/../codex-session.md"] }))
      .rejects.toThrow("canonical vault-relative path");
    await expect(runForget({ paths: ["crystals/keep.md"] }))
      .rejects.toThrow("crystals are excluded");
  });

  it("blocks a generated page with multi-lineage instead of deleting its unrelated source material", async () => {
    const selected = "raw/2026-05-20/codex-selected.md";
    const retained = "raw/2026-05-20/codex-retained.md";
    await writeAt(selected, "selected session");
    await writeAt(retained, "retained session");
    await writeWiki(
      "projects/shared.md",
      {
        type: "projects",
        title: "Shared lineage",
        generated: true,
        source_facts: [selected, retained],
        relations: { derived_from: [selected, retained] },
      },
      "Generated from two distinct sources.",
    );

    const plan = await runForget({ rawPaths: [selected] });

    expect(plan.plan.blocked).toEqual(["wiki/projects/shared.md"]);
    await expect(runForget({ mode: "apply", rawPaths: [selected] }))
      .rejects.toThrow("ambiguous manual curated content");
    expect(existsSync(join(root, ...selected.split("/")))).toBe(true);
    expect(existsSync(join(root, ...retained.split("/")))).toBe(true);
  });

  async function seedAttributableRaw(raw: string): Promise<void> {
    await writeAt(raw, "sensitive session");
    await writeAt(
      "facts/2026-05-20/session.json",
      JSON.stringify({
        version: 1,
        sourceRawPath: raw,
        sessionId: "session",
        observedAt: "2026-05-20T00:00:00.000Z",
        compressedAt: "2026-05-20T00:00:00.000Z",
        facts: [{
          title: "Sensitive",
          facts: ["sensitive session"],
          narrative: "sensitive session",
          concepts: ["sensitive"],
          files: [],
          importance: 5,
          sessionId: "session",
          sourceRawPath: raw,
          observedAt: "2026-05-20T00:00:00.000Z",
          compressedAt: "2026-05-20T00:00:00.000Z",
        }],
      }, null, 2),
    );
    await writeWiki(
      "projects/generated.md",
      {
        type: "projects",
        title: "Generated",
        generated: true,
        source_facts: [raw],
        relations: { derived_from: [raw] },
      },
      "Generated only from the selected raw session.",
    );
  }

  async function rebuildFixtureIndex(): Promise<void> {
    const index = openIndexDb({ vaultRoot: root });
    try {
      await reconcileIndex(index, root);
    } finally {
      index.close();
    }
  }

  async function writeWiki(relPath: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
    const yaml = Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n");
    await writeAt(`wiki/${relPath}`, `---\n${yaml}\n---\n\n${body}\n`);
  }

  async function writeAt(relPath: string, content: string): Promise<void> {
    const full = join(root, ...relPath.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
});
