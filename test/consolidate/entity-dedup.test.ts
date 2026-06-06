import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectEntityMergeProposals,
  findDuplicateEntityPairs,
  mergeEntityAliases,
  writeEntityMergeProposals,
} from "../../src/consolidate/entity-dedup.js";
import {
  runEntityDedup,
  runEntityMerge,
  runEntityReject,
} from "../../src/cli/commands/entity.js";
import { readRelations } from "../../src/retrieval/relations.js";
import { commitVaultChange as realCommitVaultChange } from "../../src/sync/commit-vault-change.js";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "../../src/storage/frontmatter.js";

const execFile = promisify(nodeExecFile);

describe("entity dedup", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "entity-dedup-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("finds normalized and high-similarity duplicate entity pairs", () => {
    const pairs = findDuplicateEntityPairs([
      { name: "Atlas Studio", relPath: "wiki/projects/atlas-studio.md", referenceCount: 2, isWikiTitle: true },
      { name: "atlas-studio", relPath: "wiki/tools/atlas-studio.md", referenceCount: 7 },
      { name: "Agent Memory", relPath: "wiki/projects/agent-memory.md", referenceCount: 3, isWikiTitle: true },
      { name: "AgentMemory", referenceCount: 1 },
    ]);

    expect(pairs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        leftName: "atlas-studio",
        rightName: "Atlas Studio",
        normalized: "atlasstudio",
        reason: "exact-normalized",
        suggestedCanonical: "Atlas Studio",
      }),
      expect.objectContaining({
        leftName: "AgentMemory",
        rightName: "Agent Memory",
        normalized: "agentmemory",
        reason: "exact-normalized",
        suggestedCanonical: "Agent Memory",
      }),
    ]));
  });

  it("does not merge genuinely different entities", () => {
    expect(findDuplicateEntityPairs([
      { name: "max_tokens", referenceCount: 5 },
      { name: "access_token", referenceCount: 5 },
      { name: "OpenRouter", referenceCount: 2 },
      { name: "OpenAI", referenceCount: 2 },
    ])).toEqual([]);
  });

  it("does not enumerate wiki dot-directory operational logs as merge candidates", async () => {
    await writePage("wiki/.audit/procedure-propose-1.md", {
      type: "references",
      title: "procedure propose audit",
      created: "2026-05-28",
      updated: "2026-05-28",
    });
    await writePage("wiki/.audit/procedure-propose-2.md", {
      type: "references",
      title: "procedure propose audit",
      created: "2026-05-28",
      updated: "2026-05-28",
    });
    await writePage("wiki/.scratch/procedure-propose-3.md", {
      type: "references",
      title: "procedure propose audit",
      created: "2026-05-28",
      updated: "2026-05-28",
    });

    await expect(collectEntityMergeProposals(tmp)).resolves.toEqual([]);
  });

  it("rewrites alias relation targets, records aliases, and is idempotent", async () => {
    await writePage("wiki/projects/atlas-studio.md", {
      type: "projects",
      title: "Atlas Studio",
      created: "2026-05-28",
      updated: "2026-05-28",
      relations: { uses: ["wiki/tools/vitest.md"] },
    });
    await writePage("wiki/tools/vitest.md", {
      type: "tools",
      title: "Vitest",
      created: "2026-05-28",
      updated: "2026-05-28",
      relations: { linked: ["wiki/projects/atlasstudio.md"] },
    });
    await writePage("raw/2026-05-28/codex-session.md", {
      type: "raw-session",
      title: "Raw",
      created: "2026-05-28",
      updated: "2026-05-28",
      relations: { mentions: [{ target: "Atlas Studio", confidence: 0.9 }] },
    });

    const result = await mergeEntityAliases({
      vaultRoot: tmp,
      canonical: "wiki/projects/atlas-studio.md",
      aliases: ["Atlas Studio", "wiki/projects/atlasstudio.md"],
    });
    const second = await mergeEntityAliases({
      vaultRoot: tmp,
      canonical: "wiki/projects/atlas-studio.md",
      aliases: ["Atlas Studio", "wiki/projects/atlasstudio.md"],
    });

    expect(result.changedFiles.sort()).toEqual([
      "raw/2026-05-28/codex-session.md",
      "wiki/tools/vitest.md",
    ]);
    expect(second.changedFiles).toEqual([]);
    await expect(readFile(join(tmp, "wiki", ".entity-aliases.json"), "utf-8")).resolves.toContain('"Atlas Studio": "wiki/projects/atlas-studio.md"');
    expect(await relationTargets("wiki/tools/vitest.md", "linked")).toEqual(["wiki/projects/atlas-studio.md"]);
    expect(await relationTargets("raw/2026-05-28/codex-session.md", "mentions")).toEqual(["wiki/projects/atlas-studio.md"]);
  });

  it("commits entity review, merge, and reject mutations with explicit vault paths", async () => {
    const commitVaultChange = vi.fn(async () => ({ kind: "committed" as const, commitSha: "abc1234" }));
    await writePage("wiki/projects/atlas-studio.md", {
      type: "projects",
      title: "Atlas Studio",
      created: "2026-05-28",
      updated: "2026-05-28",
    });
    await writePage("wiki/projects/atlasstudio.md", {
      type: "projects",
      title: "atlas-studio",
      created: "2026-05-28",
      updated: "2026-05-28",
    });

    await runEntityDedup({ vaultRoot: tmp, apply: true, commitVaultChange });
    await writeEntityMergeProposals(tmp, [{
      canonical: "Atlas Studio",
      canonicalTarget: "wiki/projects/atlas-studio.md",
      aliases: ["atlas-studio", "wiki/projects/atlasstudio.md"],
      normalized: "atlasstudio",
      reason: "exact-normalized",
      referenceCounts: { "Atlas Studio": 1, "atlas-studio": 1 },
    }]);
    const merged = await runEntityMerge({ vaultRoot: tmp, canonical: "Atlas Studio", commitVaultChange });
    await writeEntityMergeProposals(tmp, [{
      canonical: "Atlas Studio",
      canonicalTarget: "wiki/projects/atlas-studio.md",
      aliases: ["atlas-studio"],
      normalized: "atlasstudio",
      reason: "exact-normalized",
      referenceCounts: {},
    }]);
    const rejected = await runEntityReject({ vaultRoot: tmp, canonical: "Atlas Studio", commitVaultChange });

    expect(merged.aliasMapPath).toBe("wiki/.entity-aliases.json");
    expect(rejected.canonical).toBe("Atlas Studio");
    expect(commitVaultChange).toHaveBeenCalledWith({
      memoryRoot: tmp,
      paths: ["wiki/entity-merges-proposed.json"],
      message: "propose entity merges: 1",
    });
    expect(commitVaultChange).toHaveBeenCalledWith({
      memoryRoot: tmp,
      paths: ["wiki/.entity-aliases.json"],
      message: "merge entity: Atlas Studio",
    });
    expect(commitVaultChange).toHaveBeenCalledWith({
      memoryRoot: tmp,
      paths: ["wiki/entity-merges-proposed.json"],
      message: "reject entity: Atlas Studio",
    });
  });

  it("commits entity merge rewrites and leaves changed paths clean", async () => {
    await initGitRepo(tmp);
    await writePage("wiki/projects/atlas-studio.md", {
      type: "projects",
      title: "Atlas Studio",
      created: "2026-05-28",
      updated: "2026-05-28",
    });
    await writePage("wiki/tools/vitest.md", {
      type: "tools",
      title: "Vitest",
      created: "2026-05-28",
      updated: "2026-05-28",
      relations: { linked: ["Atlas Studio"] },
    });
    await writeEntityMergeProposals(tmp, [{
      canonical: "Atlas Studio",
      canonicalTarget: "wiki/projects/atlas-studio.md",
      aliases: ["Atlas Studio"],
      normalized: "atlasstudio",
      reason: "exact-normalized",
      referenceCounts: {},
    }]);
    await git(["add", "--", "wiki/projects/atlas-studio.md", "wiki/tools/vitest.md", "wiki/entity-merges-proposed.json"], tmp);
    await git(["commit", "-m", "seed entity merge fixture"], tmp);

    const result = await runEntityMerge({
      vaultRoot: tmp,
      canonical: "Atlas Studio",
      commitVaultChange: (opts) =>
        realCommitVaultChange({
          ...opts,
          scheduleAutoPush: async () => ({ scheduled: true, token: "unused" }),
        }),
    });

    expect(result.changedFiles).toEqual(["wiki/tools/vitest.md"]);
    await expect(git(["status", "--porcelain", "--", ...result.changedFiles, result.aliasMapPath], tmp)).resolves.toBe("");
    await expect(git(["log", "-1", "--pretty=%s"], tmp)).resolves.toBe("merge entity: Atlas Studio");
  });

  async function writePage(relPath: string, frontmatter: Frontmatter): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, serializeFrontmatter(frontmatter, `${frontmatter.title} body.\n`));
  }

  async function relationTargets(relPath: string, key: string): Promise<string[]> {
    const parsed = parseFrontmatter(await readFile(join(tmp, ...relPath.split("/")), "utf-8"));
    return (readRelations(parsed.frontmatter.relations)[key] ?? []).map((edge) => edge.target);
  }
});

async function initGitRepo(cwd: string): Promise<void> {
  await git(["init"], cwd);
  await git(["config", "user.name", "Test User"], cwd);
  await git(["config", "user.email", "test@example.com"], cwd);
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execFile("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}
