import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prospectiveOverdueCheck } from "../../../../src/cli/commands/verify/prospective-overdue.js";
import { serializeFrontmatter, type Frontmatter } from "../../../../src/storage/frontmatter.js";

const NOW = new Date("2026-05-27T00:00:00.000Z");
const SUGGESTED_FIX =
  "review wiki/prospective/ and update lifecycle on completed or expired prospective memories";

describe("prospectiveOverdueCheck", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "verify-prospective-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("passes when no prospective memories are overdue", async () => {
    await writeProspective("wiki/prospective/future.md", {
      due: "2026-05-28",
      lifecycle: "proposed",
    });
    await writeProspective("wiki/prospective/today.md", {
      due: "2026-05-27",
      lifecycle: "proposed",
    });
    await writeProspective("wiki/prospective/canonical.md", {
      due: "2026-05-01",
      lifecycle: "canonical",
    });

    const result = await runCheck();

    expect(result).toMatchObject({
      id: "prospective.overdue",
      label: "prospective memories are not overdue",
      status: "pass",
      detail: "0/2 proposed prospective memories are overdue",
    });
  });

  it("warns for one or two overdue proposed prospective memories", async () => {
    await writeProspective("wiki/prospective/one.md", {
      due: "2026-05-01",
      lifecycle: "proposed",
    });
    await writeProspective("wiki/prospective/future.md", {
      due: "2026-06-01",
      lifecycle: "proposed",
    });

    const result = await runCheck();

    expect(result).toMatchObject({
      id: "prospective.overdue",
      status: "warn",
      suggestedFix: SUGGESTED_FIX,
    });
    expect(result.detail).toContain("1/2 proposed prospective memories are overdue");
    expect(result.detail).toContain("wiki/prospective/one.md");
  });

  it("fails for three or more overdue proposed prospective memories", async () => {
    await writeProspective("wiki/prospective/one.md", {
      due: "2026-05-01",
      lifecycle: "proposed",
    });
    await writeProspective("wiki/prospective/two.md", {
      due: "2026-05-02",
      lifecycle: "proposed",
    });
    await writeProspective("wiki/prospective/three.md", {
      due: "2026-05-03",
      lifecycle: "proposed",
    });

    const result = await runCheck();

    expect(result).toMatchObject({
      id: "prospective.overdue",
      status: "fail",
      suggestedFix: SUGGESTED_FIX,
    });
    expect(result.detail).toContain("3/3 proposed prospective memories are overdue");
    expect(result.detail).toContain("wiki/prospective/one.md");
  });

  it("ignores archived wiki pages and non-proposed prospective memories", async () => {
    await writeProspective("wiki/archive/old.md", {
      due: "2026-05-01",
      lifecycle: "proposed",
    });
    await writeProspective("wiki/prospective/archived.md", {
      due: "2026-05-01",
      lifecycle: "archived",
      status: "active",
    });
    await writeProspective("wiki/prospective/status-archived.md", {
      due: "2026-05-01",
      lifecycle: "proposed",
      status: "archived",
    });

    const result = await runCheck();

    expect(result.status).toBe("pass");
    expect(result.detail).toBe("0/0 proposed prospective memories are overdue");
  });

  async function runCheck() {
    return prospectiveOverdueCheck.run({
      vaultRoot: tmp,
      now: () => NOW,
    });
  }

  async function writeProspective(
    relPath: string,
    overrides: Partial<Frontmatter>,
  ): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    const frontmatter: Frontmatter = {
      type: "prospective",
      title: relPath,
      created: "2026-05-01",
      updated: "2026-05-01",
      status: "active",
      ...overrides,
    };
    await writeFile(fullPath, serializeFrontmatter(frontmatter, `${relPath} body.\n`), "utf-8");
  }
});
