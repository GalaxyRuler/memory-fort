import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSearchCorpus } from "../../src/retrieval/corpus.js";
import { loadGraphFeed } from "../../src/dashboard/loaders.js";

// The dashboard graph loads the corpus into memory to build the graph. On a
// large vault the raw/ pool (hundreds of MB) exhausted the heap and OOM-killed
// the app. loadSearchCorpus must accept a maxRawFiles budget so dashboard
// callers can cap how many raw files are read into memory, keeping the most
// recent ones. Compile/search pass no budget and still load everything.
describe("corpus raw budget (maxRawFiles)", () => {
  async function makeVault(rawDates: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "mf-corpus-budget-"));
    // one curated wiki page (always loaded, never capped)
    const wikiDir = join(root, "wiki", "tools");
    await mkdir(wikiDir, { recursive: true });
    await writeFile(
      join(wikiDir, "page.md"),
      ["---", "type: tools", 'title: "Page"', "---", "", "Body.", ""].join("\n"),
    );
    // one raw observation per date dir
    for (const date of rawDates) {
      const dir = join(root, "raw", date);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "claude-code-sess.md"),
        ["---", "source: claude-code", `observed_at: "${date}T00:00:00Z"`, "---", "", `obs ${date}`, ""].join("\n"),
      );
    }
    return root;
  }

  const dates = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);

  it("caps raw files to the most recent N when maxRawFiles is set", async () => {
    const root = await makeVault(dates);
    const corpus = await loadSearchCorpus({ vaultRoot: root, scope: "raw", maxRawFiles: 5 });

    const rawDocs = corpus.documents.filter((d) => d.kind === "raw");
    expect(rawDocs).toHaveLength(5);
    // the 5 kept are the most recent dates (06-26 .. 06-30)
    const keptDates = rawDocs.map((d) => d.relPath.split(/[\\/]/)[1]).sort();
    expect(keptDates).toEqual(["2026-06-26", "2026-06-27", "2026-06-28", "2026-06-29", "2026-06-30"]);
    expect(corpus.rawTruncated).toBe(true);
    // the true total is still reported
    expect(corpus.scannedCounts.raw).toBe(30);
  });

  it("loads every raw file and is not truncated when no budget is given", async () => {
    const root = await makeVault(dates);
    const corpus = await loadSearchCorpus({ vaultRoot: root, scope: "raw" });

    expect(corpus.documents.filter((d) => d.kind === "raw")).toHaveLength(30);
    expect(corpus.rawTruncated).toBe(false);
  });

  it("loadGraphFeed bounds raw nodes to the given budget", async () => {
    const root = await makeVault(dates);
    const feed = await loadGraphFeed(root, "raw", 5);
    const rawNodes = feed.nodes.filter((n) => n.kind === "raw");
    expect(rawNodes).toHaveLength(5);
  });
});
