import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { curationContentLossCheck } from "../../../../src/cli/commands/verify/curation-content-loss.js";

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

function page(body: string, extraFrontmatter: { relations?: Record<string, string[]> } = {}): string {
  const relationLines = extraFrontmatter.relations
    ? [
        "relations:",
        ...Object.entries(extraFrontmatter.relations).flatMap(([key, values]) => [
          `  ${key}:`,
          ...values.map((value) => `    - ${value}`),
        ]),
      ]
    : [];
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
