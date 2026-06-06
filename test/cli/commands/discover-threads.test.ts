import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDiscoverThreadsResult, runDiscoverThreads } from "../../../src/cli/commands/discover-threads.js";
import { loadGraphFeed } from "../../../src/dashboard/loaders.js";
import { computeGraphHealth } from "../../../src/dashboard/graph-health.js";
import { loadSearchCorpus } from "../../../src/retrieval/corpus.js";
import { parseFrontmatter } from "../../../src/storage/frontmatter.js";

describe("discover-threads command", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "discover-threads-"));
    await writeMarkdown("wiki/projects/memory-system.md", page("projects", "Memory System", {
      uses: ["wiki/tools/vitest.md"],
      depends_on: ["wiki/decisions/graph-health.md"],
    }));
    await writeMarkdown("wiki/tools/vitest.md", page("tools", "Vitest", {
      mentioned_in: ["wiki/projects/memory-system.md"],
    }));
    await writeMarkdown("wiki/decisions/graph-health.md", page("decisions", "Graph Health", {
      mentions: ["wiki/projects/memory-system.md"],
    }));
    await writeMarkdown("raw/2026-06-01/codex-1.md", rawPage("Raw 1", "Memory System and Vitest graph health.", ["wiki/projects/memory-system.md"]));
    await writeMarkdown("raw/2026-06-02/codex-2.md", rawPage("Raw 2", "Graph health and Vitest.", ["wiki/tools/vitest.md"]));
    await writeMarkdown("raw/2026-06-03/codex-3.md", rawPage("Raw 3", "Memory System graph health.", ["wiki/decisions/graph-health.md"]));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("plans discovered thread proposals without writing drafts", async () => {
    const result = await runDiscoverThreads({
      vaultRoot: tmp,
      mode: "plan",
      minClusterSize: 3,
      now: new Date("2026-06-03T12:00:00.000Z"),
    });

    expect(result.summary).toMatchObject({ clusters: 1, proposals: 1, written: 0 });
    expect(result.proposals[0]).toMatchObject({
      slug: "graph-health-memory-system-vitest",
      members: [
        "wiki/decisions/graph-health.md",
        "wiki/projects/memory-system.md",
        "wiki/tools/vitest.md",
      ],
      rawReferences: [
        "raw/2026-06-01/codex-1.md",
        "raw/2026-06-02/codex-2.md",
        "raw/2026-06-03/codex-3.md",
      ],
    });
    expect(existsSync(join(tmp, "wiki", "threads-proposed", "graph-health-memory-system-vitest.md"))).toBe(false);
    expect(formatDiscoverThreadsResult(result)).toContain("Mode: plan");
  });

  it("writes proposal drafts that improve thread coverage after operator promotion", async () => {
    const result = await runDiscoverThreads({
      vaultRoot: tmp,
      mode: "apply",
      minClusterSize: 3,
      now: new Date("2026-06-03T12:00:00.000Z"),
    });

    expect(result.summary).toMatchObject({ clusters: 1, proposals: 1, written: 1 });
    const draftPath = join(tmp, "wiki", "threads-proposed", "graph-health-memory-system-vitest.md");
    const draft = parseFrontmatter(await readFile(draftPath, "utf-8"));
    expect(draft.frontmatter.lifecycle).toBe("proposed");
    expect(draft.frontmatter.relations?.mentions).toEqual([
      "raw/2026-06-01/codex-1.md",
      "raw/2026-06-02/codex-2.md",
      "raw/2026-06-03/codex-3.md",
    ]);

    await writeMarkdown("wiki/threads/graph-health-memory-system-vitest.md", await readFile(draftPath, "utf-8"));
    const feed = await loadGraphFeed(tmp, "all");
    const corpus = await loadSearchCorpus({ vaultRoot: tmp, scope: "wiki" });
    const report = computeGraphHealth({
      feed,
      wikiPages: corpus.documents,
      now: new Date("2026-06-03T12:00:00.000Z"),
    });
    expect(report.metrics.find((metric) => metric.id === "graph.narrative-thread-coverage")?.value).toBe(100);
  });

  async function writeMarkdown(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function page(type: string, title: string, relations: Record<string, string[]> = {}): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "created: 2026-06-03",
    "updated: 2026-06-03",
    "relations:",
    ...Object.entries(relations).flatMap(([key, targets]) => [
      `  ${key}:`,
      ...targets.map((target) => `    - ${target}`),
    ]),
    "---",
    "",
    `${title} page.`,
  ].join("\n");
}

function rawPage(title: string, body: string, mentions: string[]): string {
  return [
    "---",
    "type: raw-session",
    `title: ${title}`,
    "created: 2026-06-03",
    "updated: 2026-06-03",
    "importance: 8",
    "relations:",
    "  mentions:",
    ...mentions.map((target) => `    - ${target}`),
    "---",
    "",
    body,
  ].join("\n");
}
