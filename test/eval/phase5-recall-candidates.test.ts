import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  scaffoldPhase5RecallCandidates,
  serializePhase5RecallCandidatesJsonl,
} from "../../src/eval/retrieval/phase5-recall.js";

describe("Phase 5 recall candidate scaffolding", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "phase5-recall-candidates-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("combines existing gold with vault-derived candidates across the required Task 5a categories", async () => {
    const vaultRoot = join(tmp, "vault");
    const goldPath = join(tmp, "retrieval-gold.jsonl");
    await writeFile(
      goldPath,
      `${JSON.stringify({
        query: "where is the memory MCP registry",
        type: "fact",
        expected_paths: ["wiki/references/mcp-servers-available.md"],
        held_out_queries: ["how can agents find which integrations are available"],
        hard_held_out_queries: ["where should an assistant verify connector availability before asking"],
      })}\n`,
      "utf8",
    );
    await writeVaultFile(
      vaultRoot,
      "wiki/references/mcp-servers-available.md",
      page({
        title: "MCP Servers Available",
        type: "references",
        body: "The registry lists Claude, Codex, and Antigravity MCP availability.",
      }),
    );
    await writeVaultFile(
      vaultRoot,
      "wiki/projects/memory-system.md",
      page({
        title: "Memory System",
        type: "projects",
        body: "Memory System links to [[wiki/tools/voyageai]] and records graph traversal decisions.",
      }),
    );
    await writeVaultFile(
      vaultRoot,
      "wiki/tools/search-api.md",
      page({
        title: "Search API",
        type: "tools",
        body: "```ts\ncreateServer({ searchExecutor })\n```\nThe API route handles /api/search.",
      }),
    );
    await writeVaultFile(
      vaultRoot,
      "wiki/threads/2026-07-01-phase5-task.md",
      page({
        title: "Phase 5 Task Thread",
        type: "threads",
        body: "Updated metadata and date-heavy release notes for the phase five task.",
      }),
    );

    const candidates = await scaffoldPhase5RecallCandidates({
      vaultRoot,
      goldPaths: [goldPath],
      maxCandidates: 12,
    });

    expect(candidates[0]).toMatchObject({
      category: "known-target",
      query: "where is the memory MCP registry",
      suggestedExpectedPaths: ["wiki/references/mcp-servers-available.md"],
      heldOutQueries: ["how can agents find which integrations are available"],
      hardHeldOutQueries: ["where should an assistant verify connector availability before asking"],
      labelStatus: "needs-user-confirmation",
      source: "existing-gold",
    });
    expect([...new Set(candidates.map((candidate) => candidate.category))]).toEqual(
      expect.arrayContaining([
        "known-target",
        "ambiguous",
        "code-api",
        "metadata-path-heavy",
        "graph-hyde-favoring",
      ]),
    );
    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(candidates.length);
    expect(serializePhase5RecallCandidatesJsonl(candidates)).toContain("\"labelStatus\":\"needs-user-confirmation\"");
    expect(serializePhase5RecallCandidatesJsonl(candidates)).toContain("\"heldOutQueries\":[\"how can agents find which integrations are available\"]");
    expect(serializePhase5RecallCandidatesJsonl(candidates)).toContain("\"hardHeldOutQueries\":[\"where should an assistant verify connector availability before asking\"]");
  });

  it("excludes dot-directory pages and omits generic vault known-target catch-all candidates", async () => {
    const vaultRoot = join(tmp, "vault");
    await writeVaultFile(
      vaultRoot,
      "wiki/projects/memory-system.md",
      page({
        title: "Memory System",
        type: "projects",
        body: "Memory System links to [[wiki/tools/search-api]] and records graph traversal decisions.",
      }),
    );
    await writeVaultFile(
      vaultRoot,
      "wiki/.history/wiki/projects/memory-system.md/2026-07-03T00-00-00-000Z.md",
      page({
        title: "Memory System Backup",
        type: "projects",
        body: "backup-only-marker should not become candidate evidence.",
      }),
    );

    const candidates = await scaffoldPhase5RecallCandidates({
      vaultRoot,
      maxCandidates: 20,
    });

    expect(candidates.some((candidate) => candidate.source === "vault")).toBe(true);
    expect(candidates.flatMap((candidate) => candidate.suggestedExpectedPaths)).not.toContain(
      "wiki/.history/wiki/projects/memory-system.md/2026-07-03T00-00-00-000Z.md",
    );
    expect(candidates.flatMap((candidate) => candidate.evidence.map((entry) => entry.path))).not.toContain(
      "wiki/.history/wiki/projects/memory-system.md/2026-07-03T00-00-00-000Z.md",
    );
    expect(candidates.filter((candidate) => candidate.source === "vault").map((candidate) => candidate.query))
      .not.toContain("which page records Memory System");
  });
});

async function writeVaultFile(vaultRoot: string, relPath: string, content: string): Promise<void> {
  const fullPath = join(vaultRoot, ...relPath.split("/"));
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

function page(opts: { title: string; type: string; body: string }): string {
  return [
    "---",
    `title: "${opts.title}"`,
    `type: "${opts.type}"`,
    "created: \"2026-07-01\"",
    "updated: \"2026-07-01\"",
    "---",
    "",
    `# ${opts.title}`,
    "",
    opts.body,
    "",
  ].join("\n");
}
