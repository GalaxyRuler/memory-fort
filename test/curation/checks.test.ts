import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadWiki,
  checkFrontmatter,
  checkBrokenLinks,
  checkBrokenRelations,
  checkOrphans,
  checkStale,
  checkDrafts,
  checkContradictions,
  checkSupersededDependents,
  checkPruneCandidates,
  runAllChecks,
  type WikiPage,
} from "../../src/curation/checks.js";

function page(
  path: string,
  fm: Record<string, unknown>,
  body = "",
): WikiPage {
  return {
    path,
    fullPath: `/fake/${path}`,
    frontmatter: fm as never,
    body,
  };
}

describe("loadWiki", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "checks-load-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns empty array for non-existent wiki dir", async () => {
    expect(await loadWiki(join(tmp, "nonexistent"))).toEqual([]);
  });

  it("loads .md files recursively", async () => {
    await mkdir(join(tmp, "projects"), { recursive: true });
    await mkdir(join(tmp, "lessons"), { recursive: true });
    await writeFile(
      join(tmp, "projects", "a.md"),
      `---\ntype: projects\ntitle: A\ncreated: "2026-05-21"\nupdated: "2026-05-21"\n---\nbody A\n`,
    );
    await writeFile(
      join(tmp, "lessons", "b.md"),
      `---\ntype: lessons\ntitle: B\ncreated: "2026-05-21"\nupdated: "2026-05-21"\n---\nbody B\n`,
    );

    const pages = await loadWiki(tmp);
    expect(pages).toHaveLength(2);
    const paths = pages.map((p) => p.path).sort();
    expect(paths).toEqual(["lessons/b.md", "projects/a.md"]);
  });
});

describe("checkFrontmatter", () => {
  const valid: Record<string, unknown> = {
    type: "projects",
    title: "x",
    created: "2026-05-21",
    updated: "2026-05-21",
  };

  it("returns no issues for a fully valid page", () => {
    expect(checkFrontmatter([page("projects/a.md", valid)])).toEqual([]);
  });

  it("flags missing required fields", () => {
    const issues = checkFrontmatter([page("projects/a.md", { type: "projects" })]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.category).toBe("frontmatter");
    expect(issues[0]!.page).toBe("wiki/projects/a.md");
  });

  it("flags unknown relations key", () => {
    const issues = checkFrontmatter([
      page("projects/a.md", { ...valid, relations: { bogus: ["x"] } }),
    ]);
    expect(issues.some((i) => i.message.includes("bogus"))).toBe(true);
  });
});

describe("checkBrokenLinks", () => {
  it("returns no issues when all links resolve", () => {
    const pages = [
      page(
        "projects/a.md",
        {
          type: "projects",
          title: "A",
          created: "2026-05-21",
          updated: "2026-05-21",
        },
        "See [[projects/b]] and [[c]]",
      ),
      page("projects/b.md", {
        type: "projects",
        title: "B",
        created: "2026-05-21",
        updated: "2026-05-21",
      }),
      page("lessons/c.md", {
        type: "lessons",
        title: "C",
        created: "2026-05-21",
        updated: "2026-05-21",
      }),
    ];
    expect(checkBrokenLinks(pages)).toEqual([]);
  });

  it("flags unresolved inline wikilinks", () => {
    const pages = [
      page(
        "projects/a.md",
        {
          type: "projects",
          title: "A",
          created: "2026-05-21",
          updated: "2026-05-21",
        },
        "See [[missing-target]]",
      ),
    ];
    const issues = checkBrokenLinks(pages);
    expect(issues.length).toBe(1);
    expect(issues[0]!.category).toBe("broken-link");
    expect(issues[0]!.message).toContain("missing-target");
  });

  it("accepts both full-path and filename-only forms", () => {
    const pages = [
      page(
        "projects/a.md",
        {
          type: "projects",
          title: "A",
          created: "2026-05-21",
          updated: "2026-05-21",
        },
        "[[projects/b]] and [[b]]",
      ),
      page("projects/b.md", {
        type: "projects",
        title: "B",
        created: "2026-05-21",
        updated: "2026-05-21",
      }),
    ];
    expect(checkBrokenLinks(pages)).toEqual([]);
  });

  it("treats ambiguous filename-only references as broken", () => {
    const pages = [
      page(
        "projects/a.md",
        {
          type: "projects",
          title: "A",
          created: "2026-05-21",
          updated: "2026-05-21",
        },
        "See [[x]]",
      ),
      page("projects/x.md", {
        type: "projects",
        title: "P-X",
        created: "2026-05-21",
        updated: "2026-05-21",
      }),
      page("lessons/x.md", {
        type: "lessons",
        title: "L-X",
        created: "2026-05-21",
        updated: "2026-05-21",
      }),
    ];
    const issues = checkBrokenLinks(pages);
    expect(issues.some((i) => i.message.includes("[[x]]"))).toBe(true);
  });
});

describe("checkBrokenRelations", () => {
  it("returns no issues when all relations resolve", () => {
    const pages = [
      page("projects/a.md", {
        type: "projects",
        title: "A",
        created: "2026-05-21",
        updated: "2026-05-21",
        relations: { uses: ["b"] },
      }),
      page("tools/b.md", {
        type: "tools",
        title: "B",
        created: "2026-05-21",
        updated: "2026-05-21",
      }),
    ];
    expect(checkBrokenRelations(pages)).toEqual([]);
  });

  it("flags relations entries with non-existent targets", () => {
    const pages = [
      page("projects/a.md", {
        type: "projects",
        title: "A",
        created: "2026-05-21",
        updated: "2026-05-21",
        relations: { uses: ["ghost"] },
      }),
    ];
    const issues = checkBrokenRelations(pages);
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain("ghost");
  });
});

describe("checkOrphans", () => {
  it("flags a page with no inbound links or relations", () => {
    const pages = [
      page(
        "projects/a.md",
        {
          type: "projects",
          title: "A",
          created: "2026-05-21",
          updated: "2026-05-21",
        },
        "Lonely page.",
      ),
    ];
    const issues = checkOrphans(pages);
    expect(issues.length).toBe(1);
    expect(issues[0]!.category).toBe("orphan");
  });

  it("does not flag a page with an inbound link", () => {
    const pages = [
      page(
        "projects/a.md",
        {
          type: "projects",
          title: "A",
          created: "2026-05-21",
          updated: "2026-05-21",
        },
        "See [[projects/b]]",
      ),
      page("projects/b.md", {
        type: "projects",
        title: "B",
        created: "2026-05-21",
        updated: "2026-05-21",
      }),
    ];
    const orphans = checkOrphans(pages).map((i) => i.page);
    expect(orphans).toContain("wiki/projects/a.md");
    expect(orphans).not.toContain("wiki/projects/b.md");
  });

  it("does not flag a page with an inbound relation", () => {
    const pages = [
      page("projects/a.md", {
        type: "projects",
        title: "A",
        created: "2026-05-21",
        updated: "2026-05-21",
        relations: { uses: ["projects/b"] },
      }),
      page("projects/b.md", {
        type: "projects",
        title: "B",
        created: "2026-05-21",
        updated: "2026-05-21",
      }),
    ];
    const orphans = checkOrphans(pages).map((i) => i.page);
    expect(orphans).not.toContain("wiki/projects/b.md");
  });
});

describe("checkStale", () => {
  const NOW = new Date(Date.UTC(2026, 4, 21));

  it("does not flag a recently-updated page", () => {
    const pages = [
      page("projects/a.md", {
        type: "projects",
        title: "A",
        created: "2026-04-01",
        updated: "2026-05-15",
        status: "active",
      }),
    ];
    expect(checkStale(pages, { now: NOW })).toEqual([]);
  });

  it("flags status:active page older than 180 days", () => {
    const pages = [
      page("projects/a.md", {
        type: "projects",
        title: "A",
        created: "2025-08-01",
        updated: "2025-08-01",
        status: "active",
      }),
    ];
    const issues = checkStale(pages, { now: NOW });
    expect(issues.length).toBe(1);
    expect(issues[0]!.category).toBe("stale");
  });

  it("does not flag archived pages even if old", () => {
    const pages = [
      page("projects/a.md", {
        type: "projects",
        title: "A",
        created: "2024-01-01",
        updated: "2024-01-01",
        status: "archived",
      }),
    ];
    expect(checkStale(pages, { now: NOW })).toEqual([]);
  });

  it("respects custom thresholdDays", () => {
    const pages = [
      page("projects/a.md", {
        type: "projects",
        title: "A",
        created: "2026-04-01",
        updated: "2026-05-01",
        status: "active",
      }),
    ];
    expect(checkStale(pages, { now: NOW, thresholdDays: 10 }).length).toBe(1);
    expect(checkStale(pages, { now: NOW, thresholdDays: 30 }).length).toBe(0);
  });

  it("detects stale pages whose frontmatter uses unquoted YYYY-MM-DD dates", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "checks-stale-"));
    try {
      await mkdir(join(tmp, "projects"), { recursive: true });
      await writeFile(
        join(tmp, "projects", "a.md"),
        [
          "---",
          "type: projects",
          "title: A",
          "created: 2025-08-01",
          "updated: 2025-08-01",
          "status: active",
          "---",
          "body",
        ].join("\n"),
      );

      const pages = await loadWiki(tmp);
      const issues = checkStale(pages, { now: NOW });
      expect(issues).toHaveLength(1);
      expect(issues[0]!.category).toBe("stale");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("checkDrafts", () => {
  it("flags status:active with confidence < 0.5", () => {
    const pages = [
      page("projects/a.md", {
        type: "projects",
        title: "A",
        created: "2026-05-21",
        updated: "2026-05-21",
        status: "active",
        confidence: 0.3,
      }),
    ];
    const issues = checkDrafts(pages);
    expect(issues.length).toBe(1);
    expect(issues[0]!.category).toBe("draft");
  });

  it("does not flag confidence >= 0.5", () => {
    const pages = [
      page("projects/a.md", {
        type: "projects",
        title: "A",
        created: "2026-05-21",
        updated: "2026-05-21",
        status: "active",
        confidence: 0.5,
      }),
    ];
    expect(checkDrafts(pages)).toEqual([]);
  });

  it("does not flag archived low-confidence pages", () => {
    const pages = [
      page("projects/a.md", {
        type: "projects",
        title: "A",
        created: "2026-05-21",
        updated: "2026-05-21",
        status: "archived",
        confidence: 0.2,
      }),
    ];
    expect(checkDrafts(pages)).toEqual([]);
  });
});

describe("checkContradictions", () => {
  it("propagates contradiction conflicts to dependents up to two relation hops", () => {
    const pages = [
      page("decisions/postgres.md", {
        type: "decisions",
        title: "Use Postgres",
        created: "2026-05-21",
        updated: "2026-05-21",
        status: "superseded",
        relations: { contradicts: ["decisions/jsonl"] },
      }),
      page("decisions/jsonl.md", {
        type: "decisions",
        title: "Use JSONL",
        created: "2026-05-21",
        updated: "2026-05-21",
        status: "active",
      }),
      page("projects/c.md", {
        type: "projects",
        title: "C",
        created: "2026-05-21",
        updated: "2026-05-21",
        relations: { derived_from: ["decisions/postgres"] },
      }),
      page("projects/d.md", {
        type: "projects",
        title: "D",
        created: "2026-05-21",
        updated: "2026-05-21",
        relations: { uses: ["decisions/postgres"] },
      }),
      page("projects/e.md", {
        type: "projects",
        title: "E",
        created: "2026-05-21",
        updated: "2026-05-21",
        relations: { depends_on: ["decisions/postgres"] },
      }),
      page("projects/f.md", {
        type: "projects",
        title: "F",
        created: "2026-05-21",
        updated: "2026-05-21",
        relations: { linked: ["projects/c"] },
      }),
      page("projects/g.md", {
        type: "projects",
        title: "G",
        created: "2026-05-21",
        updated: "2026-05-21",
        relations: { linked: ["projects/f"] },
      }),
    ];

    const conflicts = checkContradictions(pages);
    const direct = conflicts.find((conflict) => conflict.reason === "contradiction");
    expect(direct).toMatchObject({
      pageA: "wiki/decisions/postgres.md",
      pageB: "wiki/decisions/jsonl.md",
      reason: "contradiction",
    });

    const derived = conflicts.filter((conflict) => conflict.reason === "derived-from-contradiction");
    expect(derived.map((conflict) => conflict.dependentPath).sort()).toEqual([
      "wiki/projects/c.md",
      "wiki/projects/d.md",
      "wiki/projects/e.md",
      "wiki/projects/f.md",
    ]);
    expect(derived.find((conflict) => conflict.dependentPath === "wiki/projects/f.md")?.via).toEqual([
      "projects/c.md:derived_from",
      "projects/f.md:linked",
    ]);
    expect(derived).not.toContainEqual(
      expect.objectContaining({ dependentPath: "wiki/projects/g.md" }),
    );
  });
});

describe("checkSupersededDependents", () => {
  it("flags active pages that still depend on superseded pages up to two relation hops", () => {
    const pages = [
      page("decisions/old.md", {
        type: "decisions",
        title: "Old",
        created: "2026-05-21",
        updated: "2026-05-21",
        status: "superseded",
      }),
      page("projects/direct.md", {
        type: "projects",
        title: "Direct",
        created: "2026-05-21",
        updated: "2026-05-21",
        status: "active",
        relations: { uses: ["decisions/old"] },
      }),
      page("projects/indirect.md", {
        type: "projects",
        title: "Indirect",
        created: "2026-05-21",
        updated: "2026-05-21",
        status: "active",
        relations: { linked: ["projects/direct"] },
      }),
      page("projects/too-far.md", {
        type: "projects",
        title: "Too Far",
        created: "2026-05-21",
        updated: "2026-05-21",
        status: "active",
        relations: { linked: ["projects/indirect"] },
      }),
    ];

    const issues = checkSupersededDependents(pages);
    expect(issues.map((issue) => issue.page).sort()).toEqual([
      "wiki/projects/direct.md",
      "wiki/projects/indirect.md",
    ]);
    expect(issues[0]!.category).toBe("superseded-dependent");
    expect(issues[0]!.message).toContain("wiki/decisions/old.md");
  });
});

describe("checkPruneCandidates", () => {
  it("flags only pages that are stale, orphaned, and low confidence", () => {
    const now = new Date("2026-05-24T00:00:00.000Z");
    const pages = [
      page("projects/eligible.md", {
        type: "projects",
        title: "Eligible",
        created: "2025-01-01",
        updated: "2025-01-01",
        status: "active",
        confidence: 0.3,
      }),
      page("projects/fresh.md", {
        type: "projects",
        title: "Fresh",
        created: "2026-05-01",
        updated: "2026-05-01",
        status: "active",
        confidence: 0.3,
      }),
      page("projects/confident.md", {
        type: "projects",
        title: "Confident",
        created: "2025-01-01",
        updated: "2025-01-01",
        status: "active",
        confidence: 0.8,
      }),
      page("projects/referenced.md", {
        type: "projects",
        title: "Referenced",
        created: "2025-01-01",
        updated: "2025-01-01",
        status: "active",
        confidence: 0.3,
      }),
      page(
        "projects/referrer.md",
        {
          type: "projects",
          title: "Referrer",
          created: "2026-05-01",
          updated: "2026-05-01",
          status: "active",
          confidence: 0.9,
        },
        "See [[projects/referenced]].",
      ),
    ];

    expect(checkPruneCandidates(pages, { now })).toEqual([
      {
        category: "stale-orphan-low-confidence",
        path: "wiki/projects/eligible.md",
        title: "Eligible",
        updated: "2025-01-01",
        confidence: 0.3,
      },
    ]);
  });

  it("never proposes crystals for pruning", () => {
    const pages = [
      page("crystals/insight.md", {
        type: "crystal",
        title: "Insight",
        created: "2025-01-01",
        updated: "2025-01-01",
        status: "active",
        confidence: 0.2,
      }),
    ];

    expect(
      checkPruneCandidates(pages, {
        now: new Date("2026-05-24T00:00:00.000Z"),
      }),
    ).toEqual([]);
  });
});

describe("runAllChecks", () => {
  it("returns empty for a known-good wiki", () => {
    const pages = [
      page(
        "projects/a.md",
        {
          type: "projects",
          title: "A",
          created: "2026-05-21",
          updated: "2026-05-21",
          status: "active",
          confidence: 0.9,
        },
        "Page A links to [[projects/b]].",
      ),
      page(
        "projects/b.md",
        {
          type: "projects",
          title: "B",
          created: "2026-05-21",
          updated: "2026-05-21",
          status: "active",
          confidence: 0.9,
          relations: { uses: ["projects/a"] },
        },
        "Page B back-references via relations.",
      ),
    ];
    const issues = runAllChecks(pages, { now: new Date("2026-05-21") });
    expect(issues).toEqual([]);
  });

  it("catches multiple injected issues simultaneously", () => {
    const pages = [
      page(
        "projects/a.md",
        {
          type: "projects",
          title: "A",
          created: "2026-05-21",
          updated: "2026-05-21",
          status: "active",
          confidence: 0.3,
        },
        "Orphan AND draft.",
      ),
      page(
        "projects/b.md",
        {
          type: "projects",
          title: "B",
          created: "2026-05-21",
          updated: "2026-05-21",
        },
        "Links to [[nonexistent]]",
      ),
      page("projects/c.md", {
        type: "projects",
        title: "C",
        created: "2026-05-21",
        updated: "2026-05-21",
        relations: { uses: ["ghost"] },
      }),
    ];
    const issues = runAllChecks(pages, { now: new Date("2026-05-21") });
    const categories = new Set(issues.map((i) => i.category));
    expect(categories.has("orphan")).toBe(true);
    expect(categories.has("draft")).toBe(true);
    expect(categories.has("broken-link")).toBe(true);
    expect(categories.has("broken-relation")).toBe(true);
  });
});
