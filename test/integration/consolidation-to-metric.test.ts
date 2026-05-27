import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runConsolidate } from "../../src/cli/commands/consolidate.js";
import { sourceFieldCheck } from "../../src/cli/commands/verify/source-field.js";
import { computeGraphHealth } from "../../src/dashboard/graph-health.js";
import { loadGraphFeed } from "../../src/dashboard/loaders.js";
import { loadSearchCorpus } from "../../src/retrieval/corpus.js";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "../../src/storage/frontmatter.js";

describe("consolidation to graph health integration", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "consolidation-metric-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("preserves typed consolidation edges through corpus, graph, health, and source verification", async () => {
    await writePage(
      "wiki/tools/vitest.md",
      {
        type: "tools",
        title: "Vitest",
        created: "2026-05-27",
        updated: "2026-05-27",
        status: "active",
        source: "codex",
      },
      "Vitest is the local TypeScript test runner.\n",
    );
    await writePage(
      "wiki/decisions/embedding-provider.md",
      {
        type: "decisions",
        title: "Embedding Provider Choice",
        created: "2026-05-27",
        updated: "2026-05-27",
        status: "active",
        source: "codex",
      },
      `${topicalText()} ${topicalText()} ${topicalText()}\n`,
    );
    await writePage(
      "raw/2026-05-27/codex-typed-edge.md",
      {
        type: "raw-session",
        title: "Typed edge session",
        created: "2026-05-27",
        updated: "2026-05-27",
        source: "codex",
      },
      `Vitest covered the route. ${topicalText()}\n`,
    );

    await runConsolidate({
      plan: false,
      corpusRoot: tmp,
      minConfidence: 0.5,
      maxLinksPerObservation: 5,
      now: new Date("2026-05-27T10:00:00.000Z"),
    });

    const raw = parseFrontmatter(await readFile(join(tmp, "raw", "2026-05-27", "codex-typed-edge.md"), "utf-8"));
    expect(raw.frontmatter.relations?.uses).toEqual(["wiki/tools/vitest.md"]);
    expect(raw.frontmatter.relations?.derived_from).toEqual(["wiki/decisions/embedding-provider.md"]);

    const corpus = await loadSearchCorpus({ vaultRoot: tmp, scope: "all" });
    const rawDocument = corpus.documents.find((document) => document.relPath === "raw/2026-05-27/codex-typed-edge.md");
    expect(rawDocument?.relations.uses?.map((edge) => edge.target)).toEqual(["wiki/tools/vitest.md"]);
    expect(rawDocument?.relations.derived_from?.map((edge) => edge.target)).toEqual(["wiki/decisions/embedding-provider.md"]);

    const feed = await loadGraphFeed(tmp, "all");
    expect(feed.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromPath: "raw/2026-05-27/codex-typed-edge.md",
        toPath: "wiki/tools/vitest.md",
        type: "uses",
      }),
      expect.objectContaining({
        fromPath: "raw/2026-05-27/codex-typed-edge.md",
        toPath: "wiki/decisions/embedding-provider.md",
        type: "derived_from",
      }),
    ]));

    const wikiCorpus = await loadSearchCorpus({ vaultRoot: tmp, scope: "wiki" });
    const health = computeGraphHealth({ feed, wikiPages: wikiCorpus.documents });
    const entropy = health.metrics.find((metric) => metric.id === "graph.edge-type-entropy");
    expect(typeof entropy?.value).toBe("number");
    expect(entropy?.value).toBeGreaterThan(0);

    const sourceResult = await sourceFieldCheck.run({ vaultRoot: tmp, now: () => new Date("2026-05-27") });
    expect(sourceResult.status).toBe("pass");
  });

  async function writePage(relPath: string, frontmatter: Frontmatter, body: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, serializeFrontmatter(frontmatter, body), "utf-8");
  }
});

function topicalText(): string {
  return Array.from({ length: 320 }, (_, index) => `semantic${index}`).join(" ");
}
