import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectEntityMergeProposals,
  findDuplicateEntityPairs,
  mergeEntityAliases,
} from "../../src/consolidate/entity-dedup.js";
import { readRelations } from "../../src/retrieval/relations.js";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "../../src/storage/frontmatter.js";

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
      { name: "Lisan Studio", relPath: "wiki/projects/lisan-studio.md", referenceCount: 2, isWikiTitle: true },
      { name: "lisan-studio", relPath: "wiki/tools/lisan-studio.md", referenceCount: 7 },
      { name: "Agent Memory", relPath: "wiki/projects/agent-memory.md", referenceCount: 3, isWikiTitle: true },
      { name: "AgentMemory", referenceCount: 1 },
    ]);

    expect(pairs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        leftName: "lisan-studio",
        rightName: "Lisan Studio",
        normalized: "lisanstudio",
        reason: "exact-normalized",
        suggestedCanonical: "Lisan Studio",
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
    await writePage("wiki/projects/lisan-studio.md", {
      type: "projects",
      title: "Lisan Studio",
      created: "2026-05-28",
      updated: "2026-05-28",
      relations: { uses: ["wiki/tools/vitest.md"] },
    });
    await writePage("wiki/tools/vitest.md", {
      type: "tools",
      title: "Vitest",
      created: "2026-05-28",
      updated: "2026-05-28",
      relations: { linked: ["wiki/projects/lisanstudio.md"] },
    });
    await writePage("raw/2026-05-28/codex-session.md", {
      type: "raw-session",
      title: "Raw",
      created: "2026-05-28",
      updated: "2026-05-28",
      relations: { mentions: [{ target: "Lisan Studio", confidence: 0.9 }] },
    });

    const result = await mergeEntityAliases({
      vaultRoot: tmp,
      canonical: "wiki/projects/lisan-studio.md",
      aliases: ["Lisan Studio", "wiki/projects/lisanstudio.md"],
    });
    const second = await mergeEntityAliases({
      vaultRoot: tmp,
      canonical: "wiki/projects/lisan-studio.md",
      aliases: ["Lisan Studio", "wiki/projects/lisanstudio.md"],
    });

    expect(result.changedFiles.sort()).toEqual([
      "raw/2026-05-28/codex-session.md",
      "wiki/tools/vitest.md",
    ]);
    expect(second.changedFiles).toEqual([]);
    await expect(readFile(join(tmp, "wiki", ".entity-aliases.json"), "utf-8")).resolves.toContain('"Lisan Studio": "wiki/projects/lisan-studio.md"');
    expect(await relationTargets("wiki/tools/vitest.md", "linked")).toEqual(["wiki/projects/lisan-studio.md"]);
    expect(await relationTargets("raw/2026-05-28/codex-session.md", "mentions")).toEqual(["wiki/projects/lisan-studio.md"]);
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
