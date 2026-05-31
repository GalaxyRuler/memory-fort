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

  it("warns when a canonical page is much smaller than its latest rewrite history", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page("Memory Fort keeps fact alpha."));
    await writeFileAt("wiki/.history/wiki/projects/memory-fort.md/2026-05-31T12-00-00-000Z.md", page([
      "Memory Fort keeps fact alpha.",
      "Memory Fort keeps fact beta.",
      "Memory Fort keeps fact gamma.",
      "Memory Fort keeps fact delta.",
    ].join("\n")));

    const result = await curationContentLossCheck.run({ vaultRoot: tmp, now: () => new Date("2026-05-31") });

    expect(result).toMatchObject({
      id: "curation.content-loss",
      status: "warn",
    });
    expect(result.detail).toContain("wiki/projects/memory-fort.md");
  });

  async function writeFileAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function page(body: string): string {
  return [
    "---",
    "type: projects",
    "title: Memory Fort",
    "created: 2026-05-30",
    "updated: 2026-05-31",
    "---",
    "",
    body,
    "",
  ].join("\n");
}
