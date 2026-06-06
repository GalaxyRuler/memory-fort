import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freshnessStaleCheck } from "../../../../src/cli/commands/verify/freshness.js";
import {
  serializeFrontmatter,
  type Frontmatter,
} from "../../../../src/storage/frontmatter.js";

const NOW = new Date("2026-05-27T00:00:00.000Z");
const FRESH_DATE = "2026-05-20";
const STALE_DATE = "2026-01-01";
const SUGGESTED_FIX =
  "run `memory log <page> --validate` to refresh, or set lifecycle: archived";

describe("freshnessStaleCheck", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "verify-freshness-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("passes when there are no canonical memories", async () => {
    const result = await runCheck(tmp);

    expect(result.status).toBe("pass");
    expect(result.id).toBe("freshness.staleness");
    expect(result.label).toBe("canonical memories are fresh");
    expect(result.detail).toBe("0/0 canonical memories are >90d stale");
  });

  it("passes when legacy active wiki pages are fresh", async () => {
    await writePage(tmp, "projects/a.md", {
      status: "active",
      updated: FRESH_DATE,
    });

    const result = await runCheck(tmp);

    expect(result.status).toBe("pass");
    expect(result.detail).toBe("0/1 canonical memories are >90d stale");
  });

  it("warns when 10-30% of canonical memories are stale", async () => {
    await writeManyCanonicalPages(tmp, { fresh: 17, stale: 3 });

    const result = await runCheck(tmp);

    expect(result.status).toBe("warn");
    expect(result.detail).toBe("3/20 canonical memories are >90d stale");
    expect(result.suggestedFix).toBe(SUGGESTED_FIX);
  });

  it("fails when at least 30% of canonical memories are stale", async () => {
    await writeManyCanonicalPages(tmp, { fresh: 7, stale: 3 });

    const result = await runCheck(tmp);

    expect(result.status).toBe("fail");
    expect(result.detail).toBe("3/10 canonical memories are >90d stale");
    expect(result.suggestedFix).toBe(SUGGESTED_FIX);
  });

  it("uses confidence freshness before falling back to updated", async () => {
    await writePage(tmp, "projects/fresh-by-vector.md", {
      status: "active",
      updated: STALE_DATE,
      confidence: { extraction: 0.9, freshness: FRESH_DATE },
    });
    await writePage(tmp, "projects/stale-by-vector.md", {
      status: "active",
      updated: FRESH_DATE,
      confidence: { extraction: 0.9, freshness: STALE_DATE },
    });

    const result = await runCheck(tmp);

    expect(result.status).toBe("fail");
    expect(result.detail).toBe("1/2 canonical memories are >90d stale");
  });
});

async function runCheck(vaultRoot: string) {
  return freshnessStaleCheck.run({
    vaultRoot,
    now: () => NOW,
  });
}

async function writeManyCanonicalPages(
  vaultRoot: string,
  counts: { fresh: number; stale: number },
): Promise<void> {
  for (let i = 0; i < counts.fresh; i += 1) {
    await writePage(vaultRoot, `projects/fresh-${i}.md`, {
      status: "active",
      updated: FRESH_DATE,
    });
  }
  for (let i = 0; i < counts.stale; i += 1) {
    await writePage(vaultRoot, `projects/stale-${i}.md`, {
      status: "active",
      updated: STALE_DATE,
    });
  }
}

async function writePage(
  vaultRoot: string,
  relPath: string,
  overrides: Partial<Frontmatter>,
): Promise<void> {
  const fullPath = join(vaultRoot, "wiki", relPath);
  await mkdir(dirname(fullPath), { recursive: true });
  const frontmatter: Frontmatter = {
    type: "projects",
    title: relPath,
    created: "2026-01-01",
    updated: "2026-05-20",
    ...overrides,
  };
  await writeFile(fullPath, serializeFrontmatter(frontmatter, "body"), "utf-8");
}
