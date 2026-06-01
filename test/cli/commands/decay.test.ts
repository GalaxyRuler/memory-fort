import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDecay } from "../../../src/cli/commands/decay.js";
import { parseFrontmatter, serializeFrontmatter } from "../../../src/storage/frontmatter.js";

describe("runDecay", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "decay-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("plans and applies strength decay for narrative records", async () => {
    await writePage("wiki/projects/active.md", {
      title: "Active",
      strength: 10,
      last_accessed: "2026-05-01",
    });
    await writePage("wiki/projects/stale.md", {
      title: "Stale",
      strength: 0.9,
      last_accessed: "2025-10-01",
    });
    await writePage("wiki/projects/pinned.md", {
      title: "Pinned",
      strength: 0.5,
      last_accessed: "2025-10-01",
      pinned: true,
    });

    const plan = await runDecay({ vaultRoot: tmp, mode: "plan", now: new Date("2026-06-01T00:00:00.000Z") });
    expect(plan.report).toContain("Decay plan");
    expect(plan.decayed.map((item) => item.path)).toEqual(["wiki/projects/active.md", "wiki/projects/stale.md"]);
    expect(plan.archived.map((item) => item.from)).toEqual(["wiki/projects/stale.md"]);
    expect(plan.skippedPinned).toEqual(["wiki/projects/pinned.md"]);
    expect(existsSync(join(tmp, "wiki", ".archive"))).toBe(false);

    const applied = await runDecay({ vaultRoot: tmp, mode: "apply", now: new Date("2026-06-01T00:00:00.000Z") });
    expect(applied.moved).toEqual([{
      from: "wiki/projects/stale.md",
      to: "wiki/.archive/2026-06-01/wiki/projects/stale.md",
    }]);

    const active = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "active.md"), "utf-8"));
    expect(active.frontmatter.strength).toBeCloseTo(8.1, 6);
    expect(active.frontmatter.version).toBe(1);
    expect(active.frontmatter.updated).toBe("2026-05-30");
    expect(existsSync(join(tmp, "wiki", "projects", "stale.md"))).toBe(false);
    expect(existsSync(join(tmp, "wiki", ".archive", "2026-06-01", "wiki", "projects", "stale.md"))).toBe(true);

    const pinned = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "pinned.md"), "utf-8"));
    expect(pinned.frontmatter.strength).toBe(0.5);
  });

  async function writePage(relPath: string, extra: Record<string, unknown>): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, serializeFrontmatter({
      type: "projects",
      title: String(extra.title ?? "Page"),
      created: "2026-05-30",
      updated: "2026-05-30",
      version: 1,
      ...extra,
    }, `${extra.title} is a narrative memory record.\n`), "utf-8");
  }
});
