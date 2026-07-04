import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalPhase5RecallScaffold } from "../../../src/cli/commands/eval-phase5-recall.js";
import type { Phase5RecallCandidate } from "../../../src/eval/retrieval/phase5-recall.js";

describe("Phase 5 recall eval CLI", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "phase5-recall-cli-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("prepares the index when requested and writes candidate JSONL plus Markdown", async () => {
    const candidate = {
      id: "p5-test",
      query: "where is the registry",
      category: "known-target",
      type: "fact",
      suggestedExpectedPaths: ["wiki/references/registry.md"],
      labelStatus: "needs-user-confirmation",
      source: "existing-gold",
      reason: "seed",
      evidence: [{ path: "wiki/references/registry.md", title: "Registry" }],
    } satisfies Phase5RecallCandidate;
    const prepareIndex = vi.fn(async () => ({
      indexDbPath: join(tmp, "index.db"),
      filesIndexed: 2,
      filesTombstoned: 0,
      chunks: 3,
      filesSkipped: 0,
      backfill: { cancelled: false, processed: 3, embedded: 3, reused: 0, failed: 0, stale: 0 },
      profile: {
        provider: "local",
        modelId: "BAAI/bge-small-en-v1.5",
        dimension: 384,
        dtype: "binary-int8",
      },
    }));
    const scaffold = vi.fn(async () => [candidate]);
    const jsonlPath = join(tmp, "candidates.jsonl");
    const markdownPath = join(tmp, "candidates.md");

    const result = await runEvalPhase5RecallScaffold({
      vault: join(tmp, "vault"),
      gold: ["gold.jsonl"],
      indexDb: join(tmp, "index.db"),
      candidates: jsonlPath,
      markdown: markdownPath,
      maxCandidates: 1,
      prepareIndex: true,
      prepareIndexFn: prepareIndex,
      scaffoldFn: scaffold,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Phase 5 recall candidates: 1");
    expect(prepareIndex.mock.invocationCallOrder[0]).toBeLessThan(scaffold.mock.invocationCallOrder[0] ?? 0);
    expect(JSON.parse((await readFile(jsonlPath, "utf8")).trim())).toMatchObject({ id: "p5-test" });
    expect(await readFile(markdownPath, "utf8")).toContain("where is the registry");
  });
});
