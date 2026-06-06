import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGraphFeed } from "../../src/dashboard/loaders.js";

describe("dashboard graph loader typed edges", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "dash-graph-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("exposes relation type and temporal fields with created-date default", async () => {
    await writeWiki("projects/a.md", [
      "---",
      "type: projects",
      "title: A",
      "created: 2026-05-20",
      "updated: 2026-05-22",
      "relations:",
      "  uses:",
      "    - {target: tools/b.md, valid_from: 2026-05-21, valid_to: 2026-05-23, superseded_by: tools/c.md}",
      "  depends_on:",
      "    - tools/b.md",
      "---",
      "",
      "A body.",
    ].join("\n"));
    await writeWiki("tools/b.md", page("tools", "B"));
    await writeWiki("tools/c.md", page("tools", "C"));

    const feed = await loadGraphFeed(tmp, "wiki");
    const relationEdges = feed.edges
      .filter((edge) => edge.fromPath === "wiki/projects/a.md" && edge.toPath === "wiki/tools/b.md")
      .sort((a, b) => a.type.localeCompare(b.type));

    expect(relationEdges).toHaveLength(2);
    expect(relationEdges).toEqual([
      expect.objectContaining({
        relationType: "depends_on",
        type: "depends_on",
        validFrom: "2026-05-20",
      }),
      expect.objectContaining({
        relationType: "uses",
        type: "uses",
        validFrom: "2026-05-21",
        validTo: "2026-05-23",
        supersededBy: "tools/c.md",
      }),
    ]);
  });

  async function writeWiki(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, "wiki", ...relPath.split("/"));
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function page(type: string, title: string): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "created: 2026-05-20",
    "updated: 2026-05-22",
    "---",
    "",
    `${title} body.`,
  ].join("\n");
}
