import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLinkRaw, formatLinkRawResult } from "../../../src/cli/commands/link-raw.js";
import { loadGraphFeed } from "../../../src/dashboard/loaders.js";
import { metricOrphanEpisodic } from "../../../src/dashboard/graph-health.js";
import { saveEmbeddings, type EmbeddingRecord } from "../../../src/retrieval/embeddings-store.js";
import { parseFrontmatter } from "../../../src/storage/frontmatter.js";

describe("link-raw command", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "link-raw-"));
    await writeMarkdown("wiki/projects/memory-system.md", page("projects", "Memory System"));
    await writeMarkdown("raw/2026-06-03/codex-1.md", rawPage("Codex 1", "Memory System graph health work."));
    await saveEmbeddings(tmp, "wiki", [embedding("wiki/projects/memory-system.md", vector(0))]);
    await saveEmbeddings(tmp, "raw", [embedding("raw/2026-06-03/codex-1.md", vector(0, 0.98, { 1: 0.02 }))]);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("plans orphan raw links without writing files", async () => {
    const result = await runLinkRaw({
      vaultRoot: tmp,
      mode: "plan",
      threshold: 0.75,
      configLoader: async () => ({ auto_link: { enabled: true } }),
    });

    expect(result.summary).toMatchObject({ scanned: 1, orphaned: 1, linked: 1, written: 0 });
    expect(result.files[0]).toMatchObject({
      path: "raw/2026-06-03/codex-1.md",
      outcome: "planned",
      links: [expect.objectContaining({ target: "wiki/projects/memory-system.md" })],
    });
    const parsed = parseFrontmatter(await readFile(join(tmp, "raw", "2026-06-03", "codex-1.md"), "utf-8"));
    expect(parsed.frontmatter.relations).toBeUndefined();
    expect(formatLinkRawResult(result)).toContain("Mode: plan");
  });

  it("applies links and improves the graph orphan metric on the fixture vault", async () => {
    const before = metricOrphanEpisodic(await loadGraphFeed(tmp, "all")).value;

    const result = await runLinkRaw({
      vaultRoot: tmp,
      mode: "apply",
      threshold: 0.75,
      configLoader: async () => ({ auto_link: { enabled: true } }),
      now: new Date("2026-06-03T10:00:00.000Z"),
    });

    const after = metricOrphanEpisodic(await loadGraphFeed(tmp, "all")).value;
    expect(before).toBe(100);
    expect(after).toBe(0);
    expect(result.summary).toMatchObject({ scanned: 1, orphaned: 1, linked: 1, written: 1 });
  });

  it("aborts apply before writing when candidate links mass-collide on one target", async () => {
    const rawPaths = await writeCollisionFixture();

    await expect(runLinkRaw({
      vaultRoot: tmp,
      mode: "apply",
      threshold: 0.8,
      configLoader: async () => ({
        auto_link: {
          enabled: true,
          similarity_threshold: 0.8,
          mass_collision_threshold: 0.2,
        },
      }),
    })).rejects.toThrow(/refusing to link: .* of orphans map to wiki\/projects\/hub\.md/);

    for (const rawPath of rawPaths) {
      const parsed = parseFrontmatter(await readFile(join(tmp, ...rawPath.split("/")), "utf-8"));
      expect(parsed.frontmatter.relations).toBeUndefined();
    }
  });

  it("suppresses mass-colliding targets in plan mode", async () => {
    await writeCollisionFixture();

    const result = await runLinkRaw({
      vaultRoot: tmp,
      mode: "plan",
      threshold: 0.8,
      configLoader: async () => ({
        auto_link: {
          enabled: true,
          similarity_threshold: 0.8,
          mass_collision_threshold: 0.2,
        },
      }),
    });

    expect(result.summary).toMatchObject({ scanned: 5, orphaned: 5, linked: 0, written: 0 });
    expect(result.files.every((file) => file.reason?.includes("mass-collision candidate suppressed"))).toBe(true);
  });

  async function writeMarkdown(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  async function writeCollisionFixture(): Promise<string[]> {
    await rm(tmp, { recursive: true, force: true });
    tmp = await mkdtemp(join(tmpdir(), "link-raw-collision-"));
    await writeMarkdown("wiki/projects/hub.md", page("projects", "Hub Project"));
    await writeMarkdown("wiki/tools/sidebar.md", page("tools", "Sidebar Tool"));
    const rawPaths = Array.from({ length: 5 }, (_, index) => `raw/2026-06-03/codex-${index + 1}.md`);
    for (const rawPath of rawPaths) {
      await writeMarkdown(rawPath, rawPage(rawPath, "No lexical entity title appears here."));
    }
    await saveEmbeddings(tmp, "wiki", [
      embedding("wiki/projects/hub.md", vector(0)),
      embedding("wiki/tools/sidebar.md", vector(1)),
    ]);
    await saveEmbeddings(tmp, "raw", rawPaths.map((rawPath, index) =>
      embedding(rawPath, vector(0, 1, { 1: 0.001 * (index + 1) }))
    ));
    return rawPaths;
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

function page(type: string, title: string): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "created: 2026-06-03",
    "updated: 2026-06-03",
    "---",
    "",
    `${title} page.`,
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
    "importance: 8",
    "---",
    "",
    body,
  ].join("\n");
}
