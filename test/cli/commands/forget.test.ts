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
    await writeAt("wiki/.archive/2026-05-23/raw/2026-05-20/codex-session.md", "canonical archived secret");
    await writeAt("raw/.compact-archive/2026-05-24/2026-05-20/codex-session.md", "compacted archived secret");
    await writeAt("raw/2026-05-20/codex-other.md", "same-size-sessio");
    await rebuildFixtureIndex();

    const result = await runForget({ mode: "apply", rawPaths: [raw] });

    expect(result.status).toBe("live-erased/history-retained");
    expect(result.plan.archive).toEqual([
      "raw/.compact-archive/2026-05-24/2026-05-20/codex-session.md",
      "wiki/.archive/2026-05-23/raw/2026-05-20/codex-session.md",
      "wiki/archive/2026-05-21/raw/2026-05-20/codex-session.md",
      "wiki/archive/2026-05-22/raw/2026-05-20/codex-session.md",
    ]);
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
    expect(await readFile(join(root, "wiki", ".archive", "2026-05-23", "raw", "2026-05-20", "codex-session.md"), "utf8"))
      .toContain("canonical archived secret");
    expect(await readFile(join(root, "raw", ".compact-archive", "2026-05-24", "2026-05-20", "codex-session.md"), "utf8"))
      .toContain("compacted archived secret");
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

  it("keeps compact raw archive copies out of source-selected live data and rejects them as direct raw selectors", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    const compactArchive = "raw/.compact-archive/2026-05-24/2026-05-20/codex-session.md";
    const dotArchive = "raw/.retained.md";
    const caseArchive = "raw/Archive/2026-05-24/codex-session.md";
    await writeAt(raw, "---\nsource: codex\n---\n\nlive sensitive session\n");
    await writeAt(compactArchive, "---\nsource: codex\n---\n\nretained compact archive\n");
    await writeAt(dotArchive, "---\nsource: codex\n---\n\nretained dot archive\n");
    await writeAt(caseArchive, "---\nsource: codex\n---\n\nretained case archive\n");

    const plan = await runForget({ sourceIds: ["codex"] });
    expect(plan.plan.raw).toEqual([raw]);
    expect(plan.plan.archive).toEqual([compactArchive]);

    const applied = await runForget({ mode: "apply", sourceIds: ["codex"] });
    expect(applied.erased).toEqual([raw]);
    expect(existsSync(join(root, ...raw.split("/")))).toBe(false);
    expect(existsSync(join(root, ...compactArchive.split("/")))).toBe(true);
    for (const archivedPath of ["raw/.compact-archive", compactArchive, dotArchive, caseArchive]) {
      await expect(runForget({ rawPaths: [archivedPath] }))
        .rejects.toThrow("archived raw copies cannot be selected");
      await expect(runForget({ paths: [archivedPath] }))
        .rejects.toThrow("archived raw copies cannot be selected");
    }
  });

  it("keeps archived fact copies inventory-only for whole and partial lineage matches", async () => {
    const selected = "raw/2026-05-20/codex-selected.md";
    const retained = "raw/2026-05-20/codex-retained.md";
    const wholeArchive = "facts/Archive/2026-05-24/selected.json";
    const mixedArchive = "facts/.archive/2026-05-24/mixed.json";
    await writeAt(selected, "selected session");
    await writeAt(retained, "retained session");
    await writeAt(wholeArchive, JSON.stringify([{ sourceRawPath: selected, narrative: "archived selected" }]));
    await writeAt(mixedArchive, JSON.stringify({
      facts: [
        { sourceRawPath: selected, narrative: "archived selected" },
        { sourceRawPath: retained, narrative: "archived retained" },
      ],
    }));

    const result = await runForget({ mode: "apply", rawPaths: [selected] });

    expect(result.plan.archive).toEqual([mixedArchive, wholeArchive]);
    expect(result.erased).not.toEqual(expect.arrayContaining([wholeArchive, mixedArchive]));
    expect(result.rewritten).not.toEqual(expect.arrayContaining([wholeArchive, mixedArchive]));
    await expect(readFile(join(root, ...wholeArchive.split("/")), "utf8")).resolves.toContain(selected);
    await expect(readFile(join(root, ...mixedArchive.split("/")), "utf8")).resolves.toContain(selected);
    await expect(readFile(join(root, ...mixedArchive.split("/")), "utf8")).resolves.toContain(retained);
  });

  it("rejects an apply with no live source match instead of rebuilding or reporting erased data", async () => {
    await expect(runForget({ mode: "apply", sourceIds: ["unknown-source"] }))
      .rejects.toThrow("no live data matched selectors");
    expect(existsSync(process.env["MEMORY_INDEX_DB_PATH"]!)).toBe(false);
  });

  it("invalidates stale derived search state before reporting an incomplete rebuild", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    await seedAttributableRaw(raw);
    await rebuildFixtureIndex();
    const indexPath = process.env["MEMORY_INDEX_DB_PATH"]!;
    expect(existsSync(indexPath)).toBe(true);
    await writeAt("wiki/projects/malformed.md", "---\ntitle: [\n---\n\nmalformed\n");

    await expect(runForget({ mode: "apply", rawPaths: [raw] }))
      .rejects.toThrow("live data erased but derived index rebuild/index invalidation is incomplete");

    expect(existsSync(join(root, ...raw.split("/")))).toBe(false);
    expect(existsSync(indexPath)).toBe(false);
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

  it("blocks generated pages selected directly or by source when canonical raw lineage is absent", async () => {
    await writeWiki(
      "projects/no-provenance.md",
      { type: "projects", title: "No provenance", generated: true },
      "A generated page with no canonical raw lineage.",
    );
    await writeWiki(
      "projects/broad-source.md",
      { type: "projects", title: "Broad source", generated: true, source: "compile" },
      "A generated page selected only through a broad source label.",
    );

    const direct = await runForget({ paths: ["wiki/projects/no-provenance.md"] });
    const broad = await runForget({ sourceIds: ["compile"] });

    expect(direct.plan.blocked).toEqual(["wiki/projects/no-provenance.md"]);
    expect(broad.plan.blocked).toEqual(["wiki/projects/broad-source.md"]);
    await expect(runForget({ mode: "apply", paths: ["wiki/projects/no-provenance.md"] }))
      .rejects.toThrow("ambiguous manual curated content");
    await expect(runForget({ mode: "apply", sourceIds: ["compile"] }))
      .rejects.toThrow("ambiguous manual curated content");
    expect(existsSync(join(root, "wiki", "projects", "no-provenance.md"))).toBe(true);
    expect(existsSync(join(root, "wiki", "projects", "broad-source.md"))).toBe(true);
  });

  it("does not claim a zero external-backup inventory when the backup target is not recorded", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    await writeAt(raw, "sensitive session");
    const externalTarget = join(tmp, "external-backups");
    await mkdir(externalTarget, { recursive: true });
    await writeFile(join(externalTarget, "backup-manifest.json"), "{}\n");

    const plan = await runForget({ rawPaths: [raw] });

    expect(plan.plan.history.backupManifests).toEqual([]);
    expect(plan.plan.history.externalBackupDiscovery).toBe("unavailable-or-not-configured");
    expect(plan.report).toContain("External backup discovery: unavailable or not configured");
  });

  it("reports a fact file as partially redacted when unrelated facts remain", async () => {
    const selected = "raw/2026-05-20/codex-selected.md";
    const retained = "raw/2026-05-20/codex-retained.md";
    await writeAt(selected, "selected session");
    await writeAt(retained, "retained session");
    await writeAt(
      "facts/2026-05-20/mixed.json",
      JSON.stringify({
        facts: [
          { sourceRawPath: selected, narrative: "selected" },
          { sourceRawPath: retained, narrative: "retained" },
        ],
      }),
    );

    const plan = await runForget({ rawPaths: [selected] });
    const applied = await runForget({ mode: "apply", rawPaths: [selected] });

    expect(plan.plan.facts).toEqual([]);
    expect(plan.plan.rewrittenFacts).toEqual(["facts/2026-05-20/mixed.json"]);
    expect(applied.erased).not.toContain("facts/2026-05-20/mixed.json");
    expect(applied.rewritten).toEqual(["facts/2026-05-20/mixed.json"]);
    expect(applied.report).toContain("Derived fact files partially redacted: 1");
    expect(applied.report).toContain("Partially redacted fact files retained: facts/2026-05-20/mixed.json");
    await expect(readFile(join(root, "facts", "2026-05-20", "mixed.json"), "utf8"))
      .resolves.toContain(retained);
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
