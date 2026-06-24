import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSearchCorpus } from "../../src/retrieval/corpus.js";
import { loadGraphFeed } from "../../src/dashboard/loaders.js";

// The dashboard graph loads the corpus into memory to build the graph. A raw/
// pool of hundreds of MB OOM-killed the app. A file-COUNT cap is too loose when
// raw files vary wildly in size (small captures vs 20-30MB sessions), so
// loadSearchCorpus takes a maxRawBytes budget: keep the most recent raw files
// (relPath embeds the date) until their on-disk size reaches the budget.
// Compile/search pass no budget and still load everything.
describe("corpus raw budget (maxRawBytes)", () => {
  const BODY_BYTES = 100_000; // ~100KB per raw file

  async function makeVault(rawDates: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "mf-corpus-budget-"));
    const wikiDir = join(root, "wiki", "tools");
    await mkdir(wikiDir, { recursive: true });
    await writeFile(join(wikiDir, "page.md"), ["---", "type: tools", 'title: "Page"', "---", "", "Body.", ""].join("\n"));
    for (const date of rawDates) {
      const dir = join(root, "raw", date);
      await mkdir(dir, { recursive: true });
      const body = "x".repeat(BODY_BYTES);
      await writeFile(join(dir, "claude-code-sess.md"), ["---", "source: claude-code", `observed_at: "${date}T00:00:00Z"`, "---", "", body, ""].join("\n"));
    }
    return root;
  }

  const dates = Array.from({ length: 10 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);

  it("keeps the most recent raw files until the byte budget is reached", async () => {
    const root = await makeVault(dates);
    // budget fits 3 files (~100KB each): the 3rd is added while the running
    // total is still under budget, the 4th is not.
    const corpus = await loadSearchCorpus({ vaultRoot: root, scope: "raw", maxRawBytes: 250_000 });

    const rawDocs = corpus.documents.filter((d) => d.kind === "raw");
    expect(rawDocs).toHaveLength(3);
    const keptDates = rawDocs.map((d) => d.relPath.split(/[\\/]/)[1]).sort();
    expect(keptDates).toEqual(["2026-06-08", "2026-06-09", "2026-06-10"]);
    expect(corpus.rawTruncated).toBe(true);
    expect(corpus.scannedCounts.raw).toBe(10); // true total still reported
  });

  it("loads every raw file and is not truncated when no budget is given", async () => {
    const root = await makeVault(dates);
    const corpus = await loadSearchCorpus({ vaultRoot: root, scope: "raw" });
    expect(corpus.documents.filter((d) => d.kind === "raw")).toHaveLength(10);
    expect(corpus.rawTruncated).toBe(false);
  });

  it("loadGraphFeed bounds raw nodes to the given byte budget", async () => {
    const root = await makeVault(dates);
    const feed = await loadGraphFeed(root, "raw", 250_000);
    expect(feed.nodes.filter((n) => n.kind === "raw")).toHaveLength(3);
  });
});
