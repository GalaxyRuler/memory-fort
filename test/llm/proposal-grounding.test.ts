import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractProposalCandidates,
  filterStepCommands,
  filterWikiReferencesToExisting,
} from "../../src/llm/proposal-grounding.js";

describe("proposal grounding", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "proposal-grounding-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("extracts only existing wiki relation targets from cluster observations", async () => {
    await writeMarkdown("wiki/projects/memory-fort.md");
    await writeMarkdown("wiki/decisions/settings-ui.md");

    const candidates = await extractProposalCandidates({
      vaultRoot: tmp,
      observations: [
        {
          relPath: "raw/2026-05-28/codex-a.md",
          relations: {
            mentions: [
              { target: "wiki/projects/memory-fort.md" },
              { target: "wiki/decisions/missing.md" },
              { target: "raw/2026-05-28/codex-b.md" },
            ],
            derived_from: [{ target: "wiki/decisions/settings-ui.md" }],
          },
        },
      ],
    });

    expect(candidates).toEqual({
      wikiPagePaths: [
        "wiki/decisions/settings-ui.md",
        "wiki/projects/memory-fort.md",
      ],
      candidateRationale: "2 existing wiki pages referenced by this cluster",
    });
  });

  it("caps candidates at 50 using relation frequency before alphabetical order", async () => {
    const observations = [];
    for (let index = 1; index <= 55; index += 1) {
      const relPath = `wiki/references/page-${String(index).padStart(2, "0")}.md`;
      await writeMarkdown(relPath);
      observations.push({
        relPath: `raw/2026-05-28/codex-${index}.md`,
        relations: { mentions: [{ target: relPath }] },
      });
    }
    observations.push({
      relPath: "raw/2026-05-28/codex-hot.md",
      relations: {
        mentions: [
          { target: "wiki/references/page-55.md" },
          { target: "wiki/references/page-54.md" },
        ],
      },
    });

    const candidates = await extractProposalCandidates({
      vaultRoot: tmp,
      observations,
    });

    expect(candidates.wikiPagePaths).toHaveLength(50);
    expect(candidates.wikiPagePaths).toContain("wiki/references/page-55.md");
    expect(candidates.wikiPagePaths).toContain("wiki/references/page-54.md");
    expect(candidates.wikiPagePaths).not.toContain("wiki/references/page-53.md");
  });

  it("filters missing wiki references while preserving real wiki and raw paths", async () => {
    await writeMarkdown("wiki/decisions/settings-ui.md");
    await writeMarkdown("raw/2026-05-28/codex-a.md");

    const result = await filterWikiReferencesToExisting(tmp, [
      "wiki/decisions/settings-ui.md",
      "wiki/decisions/invented.md",
      "raw/2026-05-28/codex-a.md",
      "plain prose note",
    ]);

    expect(result.filtered).toEqual([
      "wiki/decisions/settings-ui.md",
      "raw/2026-05-28/codex-a.md",
      "plain prose note",
    ]);
    expect(result.stripped).toEqual(["wiki/decisions/invented.md"]);
  });

  it("drops unsupported procedure commands and invented memory subcommands", () => {
    const result = filterStepCommands([
      { description: "Use the supported CLI", command: "memory verify --offline" },
      { description: "Run a real shell command", command: "npm run build" },
      { description: "Invented memory command", command: "memory frobnicate now" },
      { description: "Unsupported helper", command: "run-automation daily-review" },
    ]);

    expect(result.steps).toEqual([
      { description: "Use the supported CLI", command: "memory verify --offline" },
      { description: "Run a real shell command", command: "npm run build" },
      { description: "Invented memory command" },
      { description: "Unsupported helper" },
    ]);
    expect(result.stripped).toEqual([
      "memory frobnicate now",
      "run-automation daily-review",
    ]);
  });

  async function writeMarkdown(relPath: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, "---\ntitle: Fixture\n---\n\nBody.\n", "utf-8");
  }
});
