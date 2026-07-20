import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { curationContentLossCheck, reviewedContentHash } from "../../../../src/cli/commands/verify/curation-content-loss.js";

describe("curationContentLossCheck", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "verify-content-loss-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("passes when a canonical page is shorter but keeps salient rewrite anchors", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page(
      "Memory Fort keeps [[tools/codex]] and Codex Desktop anchors.",
      { relations: { uses: ["wiki/tools/codex.md"] } },
    ));
    await writeFileAt("wiki/.history/wiki/projects/memory-fort.md/2026-05-31T12-00-00-000Z.md", page(
      [
        "Memory Fort keeps [[tools/codex]] and Codex Desktop anchors.",
        "Memory Fort repeated [[tools/codex]] in multiple dated sections.",
        "Codex Desktop appeared again in a duplicate update.",
      ].join("\n"),
      { relations: { uses: ["wiki/tools/codex.md"] } },
    ));

    const result = await curationContentLossCheck.run({ vaultRoot: tmp, now: () => new Date("2026-05-31") });

    expect(result).toMatchObject({
      id: "curation.content-loss",
      status: "pass",
    });
  });

  it("warns when a canonical page drops anchors from its latest rewrite history", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page("Memory Fort keeps a generic summary."));
    await writeFileAt("wiki/.history/wiki/projects/memory-fort.md/2026-05-31T12-00-00-000Z.md", page(
      "Memory Fort used [[tools/codex]] and Codex Desktop.",
      { relations: { uses: ["wiki/tools/codex.md"] } },
    ));

    const result = await curationContentLossCheck.run({ vaultRoot: tmp, now: () => new Date("2026-05-31") });

    expect(result).toMatchObject({
      id: "curation.content-loss",
      status: "warn",
    });
    expect(result.detail).toContain("wiki/projects/memory-fort.md");
  });

  it("clears the warning when the loss is marked reviewed at or after the snapshot", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page(
      "Memory Fort keeps a generic summary.",
      {
        content_loss_reviewed: "2026-06-01T00:00:00.000Z",
        content_loss_reviewed_hash: reviewedContentHash("Memory Fort keeps a generic summary."),
      },
    ));
    await writeFileAt("wiki/.history/wiki/projects/memory-fort.md/2026-05-31T12-00-00-000Z.md", page(
      "Memory Fort used [[tools/codex]] and Codex Desktop.",
      { relations: { uses: ["wiki/tools/codex.md"] } },
    ));

    const result = await curationContentLossCheck.run({ vaultRoot: tmp, now: () => new Date("2026-06-01") });

    expect(result).toMatchObject({ id: "curation.content-loss", status: "pass" });
  });

  it("re-arms when a rewrite lands after the reviewed marker", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page(
      "Memory Fort keeps a generic summary.",
      { content_loss_reviewed: "2026-05-30T00:00:00.000Z" },
    ));
    await writeFileAt("wiki/.history/wiki/projects/memory-fort.md/2026-05-31T12-00-00-000Z.md", page(
      "Memory Fort used [[tools/codex]] and Codex Desktop.",
      { relations: { uses: ["wiki/tools/codex.md"] } },
    ));

    const result = await curationContentLossCheck.run({ vaultRoot: tmp, now: () => new Date("2026-06-01") });

    expect(result).toMatchObject({ id: "curation.content-loss", status: "warn" });
  });

  it("does not warn for structural entity labels when link and code anchors survive", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page(
      "Memory Fort keeps [[tools/codex]] and `src/index.ts` anchors.",
      { relations: { uses: ["wiki/tools/codex.md"] } },
    ));
    await writeFileAt("wiki/.history/wiki/projects/memory-fort.md/2026-05-31T12-00-00-000Z.md", page(
      [
        "## How it surfaced",
        "",
        "Memory Fort keeps [[tools/codex]] and `src/index.ts` anchors.",
      ].join("\n"),
      { relations: { uses: ["wiki/tools/codex.md"] } },
    ));

    const result = await curationContentLossCheck.run({ vaultRoot: tmp, now: () => new Date("2026-05-31") });

    expect(result).toMatchObject({
      id: "curation.content-loss",
      status: "pass",
    });
  });

  async function writeFileAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function page(
  body: string,
  extraFrontmatter: { relations?: Record<string, string[]>; content_loss_reviewed?: string; content_loss_reviewed_hash?: string } = {},
): string {
  const relationLines = extraFrontmatter.relations
    ? [
        "relations:",
        ...Object.entries(extraFrontmatter.relations).flatMap(([key, values]) => [
          `  ${key}:`,
          ...values.map((value) => `    - ${value}`),
        ]),
      ]
    : [];
  if (extraFrontmatter.content_loss_reviewed) {
    relationLines.push(`content_loss_reviewed: "${extraFrontmatter.content_loss_reviewed}"`);
  }
  if (extraFrontmatter.content_loss_reviewed_hash) {
    relationLines.push(`content_loss_reviewed_hash: "${extraFrontmatter.content_loss_reviewed_hash}"`);
  }
  return [
    "---",
    "type: projects",
    "title: Memory Fort",
    "created: 2026-05-30",
    "updated: 2026-05-31",
    ...relationLines,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

describe("content_loss_reviewed hash binding", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "content-loss-hash-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("re-arms when the page changes after the acknowledgment", async () => {
    const body = "Memory Fort keeps a generic summary, edited after review.";
    await writeAt("wiki/projects/memory-fort.md", pageWith(body, {
      content_loss_reviewed: "2026-06-01T00:00:00.000Z",
      // Hash of the ORIGINAL reviewed content — the body above differs.
      content_loss_reviewed_hash: reviewedContentHash("Memory Fort keeps a generic summary."),
    }));
    await writeAt("wiki/.history/wiki/projects/memory-fort.md/2026-05-31T12-00-00-000Z.md", pageWith(
      "Memory Fort used [[tools/codex]] and Codex Desktop.",
      { relationsBlock: ["relations:", "  uses:", "    - wiki/tools/codex.md"] },
    ));

    const result = await curationContentLossCheck.run({ vaultRoot: tmp, now: () => new Date("2026-06-02") });

    expect(result).toMatchObject({ id: "curation.content-loss", status: "warn" });
  });

  it("suppresses only while the acknowledged content is unchanged", async () => {
    const body = "Memory Fort keeps a generic summary.";
    await writeAt("wiki/projects/memory-fort.md", pageWith(body, {
      content_loss_reviewed: "2026-06-01T00:00:00.000Z",
      content_loss_reviewed_hash: reviewedContentHash(body),
    }));
    await writeAt("wiki/.history/wiki/projects/memory-fort.md/2026-05-31T12-00-00-000Z.md", pageWith(
      "Memory Fort used [[tools/codex]] and Codex Desktop.",
      { relationsBlock: ["relations:", "  uses:", "    - wiki/tools/codex.md"] },
    ));

    const result = await curationContentLossCheck.run({ vaultRoot: tmp, now: () => new Date("2026-06-02") });

    expect(result).toMatchObject({ id: "curation.content-loss", status: "pass" });
  });

  async function writeAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  function pageWith(
    body: string,
    opts: { content_loss_reviewed?: string; content_loss_reviewed_hash?: string; relationsBlock?: string[] } = {},
  ): string {
    const extra: string[] = [...(opts.relationsBlock ?? [])];
    if (opts.content_loss_reviewed) extra.push(`content_loss_reviewed: "${opts.content_loss_reviewed}"`);
    if (opts.content_loss_reviewed_hash) extra.push(`content_loss_reviewed_hash: "${opts.content_loss_reviewed_hash}"`);
    return ["---", "type: projects", "title: Memory Fort", ...extra, "---", "", body].join("\n");
  }
});
