import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runBackfillSource } from "../../../src/cli/commands/backfill-source.js";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "../../../src/storage/frontmatter.js";

describe("runBackfillSource", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "backfill-source-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("plans missing and unknown wiki sources without writing", async () => {
    await writeWiki("wiki/.audit/agentmemory-migration-2026.md", { title: "Migration audit", source: "unknown" });
    await writeWiki("wiki/crystals/validation-is-key.md", { title: "Validation", omitSource: true, type: "crystal" });
    await writeWiki("wiki/projects/already-sourced.md", { title: "Sourced", source: "codex" });
    await writeWiki("wiki/archive/old.md", { title: "Archived", source: "unknown" });

    const result = await runBackfillSource({
      vaultRoot: tmp,
      mode: "plan",
      now: new Date("2026-05-27T10:00:00.000Z"),
    });

    expect(result.report).toContain("Memory backfill-source plan");
    expect(result.report).toContain("total wiki pages: 3 (excluding archive)");
    expect(result.report).toContain("missing/unknown source: 2");
    expect(result.report).toContain("wiki/.audit/agentmemory-migration-2026.md -> import-agentmemory");
    expect(result.report).toContain("wiki/crystals/validation-is-key.md -> crystal-extraction");
    expect(result.report).toContain("unmatched: 0");
    expect(parseFrontmatter(await readFull("wiki/crystals/validation-is-key.md")).frontmatter.source).toBeUndefined();
    expect(result.auditLogPath).toBeUndefined();
  });

  it("applies path-based sources, skips already-sourced pages, and writes an audit log", async () => {
    await writeWiki("wiki/.audit/agentmemory-migration-2026.md", { title: "Migration audit", source: "unknown" });
    await writeWiki("wiki/.audit/backfill-2026.md", { title: "Backfill audit", omitSource: true });
    await writeWiki("wiki/.audit/consolidate-2026.md", { title: "Consolidate audit", source: "unknown" });
    await writeWiki("wiki/crystals/project-management.md", { title: "Project management", omitSource: true, type: "crystal" });
    await writeWiki("wiki/references/fork-smoke-marker-codex-fork-smoke-abc.md", { title: "Fork smoke", source: "unknown" });
    await writeWiki("wiki/projects/already-sourced.md", { title: "Sourced", source: "codex" });

    const result = await runBackfillSource({
      vaultRoot: tmp,
      mode: "apply",
      now: new Date("2026-05-27T10:00:00.000Z"),
    });

    expect(result.report).toContain("Memory backfill-source apply");
    expect(result.report).toContain("missing/unknown source: 5");
    await expect(sourceOf("wiki/.audit/agentmemory-migration-2026.md")).resolves.toBe("import-agentmemory");
    await expect(sourceOf("wiki/.audit/backfill-2026.md")).resolves.toBe("backfill");
    await expect(sourceOf("wiki/.audit/consolidate-2026.md")).resolves.toBe("consolidate");
    await expect(sourceOf("wiki/crystals/project-management.md")).resolves.toBe("crystal-extraction");
    await expect(sourceOf("wiki/references/fork-smoke-marker-codex-fork-smoke-abc.md")).resolves.toBe("codex-fork-smoke");
    await expect(sourceOf("wiki/projects/already-sourced.md")).resolves.toBe("codex");

    expect(result.auditLogPath).toBe(join(tmp, "wiki", ".audit", "backfill-source-2026-05-27T10-00-00-000Z.md"));
    const audit = parseFrontmatter(await readFile(result.auditLogPath!, "utf-8"));
    expect(audit.frontmatter.source).toBe("backfill-source");
    expect(audit.body).toContain("[write] wiki/crystals/project-management.md -> crystal-extraction");
  });

  it("is a no-op on a clean vault unless force is enabled", async () => {
    await writeWiki("wiki/crystals/validation-is-key.md", {
      title: "Validation",
      type: "crystal",
      source: "legacy-crystal",
    });

    const normal = await runBackfillSource({
      vaultRoot: tmp,
      mode: "apply",
      now: new Date("2026-05-27T10:00:00.000Z"),
    });
    expect(normal.changed).toBe(0);
    expect(normal.auditLogPath).toBeUndefined();
    expect(await sourceOf("wiki/crystals/validation-is-key.md")).toBe("legacy-crystal");

    const forced = await runBackfillSource({
      vaultRoot: tmp,
      mode: "apply",
      force: true,
      now: new Date("2026-05-27T10:01:00.000Z"),
    });
    expect(forced.changed).toBe(1);
    expect(await sourceOf("wiki/crystals/validation-is-key.md")).toBe("crystal-extraction");
  });

  it("reports unmatched missing-source pages without changing them", async () => {
    await writeWiki("wiki/projects/mystery.md", { title: "Mystery", source: "unknown" });

    const result = await runBackfillSource({
      vaultRoot: tmp,
      mode: "apply",
      now: new Date("2026-05-27T10:00:00.000Z"),
    });

    expect(result.report).toContain("unmatched: 1");
    expect(result.report).toContain("wiki/projects/mystery.md");
    expect(await sourceOf("wiki/projects/mystery.md")).toBe("unknown");
    expect(result.changed).toBe(0);
    expect(result.auditLogPath).toBeUndefined();
  });

  async function writeWiki(
    relPath: string,
    opts: { title: string; source?: string; omitSource?: boolean; type?: Frontmatter["type"] },
  ): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    const frontmatter: Frontmatter = {
      type: opts.type ?? "projects",
      title: opts.title,
      created: "2026-05-20",
      updated: "2026-05-20",
      status: "active",
      ...(opts.omitSource ? {} : { source: opts.source ?? "unknown" }),
    };
    await writeFile(fullPath, serializeFrontmatter(frontmatter, `${opts.title} body.\n`), "utf-8");
  }

  async function readFull(relPath: string): Promise<string> {
    return readFile(join(tmp, ...relPath.split("/")), "utf-8");
  }

  async function sourceOf(relPath: string): Promise<unknown> {
    return parseFrontmatter(await readFull(relPath)).frontmatter.source;
  }
});
