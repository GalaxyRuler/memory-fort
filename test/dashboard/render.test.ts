import { describe, expect, it } from "vitest";
import type { DashboardStatus, PageDetail, WikiIndex } from "../../src/dashboard/loaders.js";
import { renderHomepage, renderRawSession, renderWikiIndex, renderWikiPage } from "../../src/dashboard/render.js";

function fixture(overrides: Partial<DashboardStatus> = {}): DashboardStatus {
  return {
    vaultRoot: "/root/memory-system/vault",
    repoHead: {
      sha: "abcdef1234567890",
      shortSha: "abcdef1",
      subject: "curated memory update",
      committedAt: "2026-05-23T01:00:00.000Z",
    },
    counts: { wikiPages: 12, rawObservations: 19, crystals: 0 },
    lastCompile: {
      timestamp: "2026-05-22 20:00:00",
      line: "## [2026-05-22 20:00:00] compile | test",
    },
    errorsLog: { sizeBytes: 0, lastLine: null, isClean: true },
    syncState: {
      lastSyncAttempt: "2026-05-23T01:05:00.000Z",
      lastSyncSuccess: "2026-05-23T01:05:00.000Z",
      pendingPushCount: 0,
      conflictsPending: 0,
      conflictFiles: [],
    },
    generatedAt: "2026-05-23T01:10:00.000Z",
    ...overrides,
  };
}

describe("dashboard render", () => {
  it("renderHomepage includes all required sections", () => {
    const html = renderHomepage(fixture());

    expect(html).toContain('id="sync"');
    expect(html).toContain('id="counts"');
    expect(html).toContain('id="head"');
    expect(html).toContain('id="compile"');
    expect(html).toContain('id="errors"');
  });

  it("renderHomepage renders the conflict banner when conflictsPending > 0", () => {
    const html = renderHomepage(
      fixture({
        syncState: {
          lastSyncAttempt: "2026-05-23T01:05:00.000Z",
          lastSyncSuccess: null,
          pendingPushCount: 0,
          conflictsPending: 2,
          conflictFiles: ["a.md", "b.md"],
        },
      }),
    );

    expect(html).toContain("2 files have unresolved sync conflicts");
    expect(html).toContain("a.md");
    expect(html).toContain("b.md");
  });

  it("renderHomepage escapes HTML in user-provided strings", () => {
    const html = renderHomepage(
      fixture({
        repoHead: {
          sha: "abcdef1234567890",
          shortSha: "abcdef1",
          subject: "<script>alert('x')</script>",
          committedAt: "2026-05-23T01:00:00.000Z",
        },
      }),
    );

    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('x')</script>");
  });

  it("renderWikiIndex lists pages grouped by category with links", () => {
    const index: WikiIndex = {
      total: 2,
      byCategory: {
        decisions: [
          {
            category: "decisions",
            slug: "bar",
            relPath: "decisions/bar.md",
            title: "Bar",
            summary: "Bar summary",
            updated: "2026-05-23",
          },
        ],
        projects: [
          {
            category: "projects",
            slug: "foo",
            relPath: "projects/foo.md",
            title: "Foo",
            summary: "Foo summary",
            updated: "2026-05-23",
          },
        ],
      },
    };

    const html = renderWikiIndex(index);

    expect(html).toContain("<h2>decisions</h2>");
    expect(html).toContain("<h2>projects</h2>");
    expect(html).toContain('<a href="/wiki/projects/foo">');
    expect(html).toContain('<a href="/wiki/decisions/bar">');
  });

  it("renderWikiPage renders relations + inbound sections with proper links", () => {
    const page: PageDetail = {
      relPath: "projects/a.md",
      frontmatter: {
        type: "projects",
        title: "A",
        created: "2026-05-21",
        updated: "2026-05-23",
        status: "active",
        confidence: 0.8,
        tags: ["phase3"],
      },
      body: "A body.",
      relations: [
        { key: "uses", target: "b", resolvedPath: "projects/b.md", resolvedTitle: "B" },
        { key: "uses", target: "ghost", resolvedPath: null, resolvedTitle: null },
      ],
      inbound: [
        { fromPath: "lessons/c.md", fromTitle: "C", via: "wikilink" },
        { fromPath: "projects/d.md", fromTitle: "D", via: "relation:uses" },
      ],
    };

    const html = renderWikiPage(page);

    expect(html).toContain('<a href="/wiki/projects/b">');
    expect(html).toContain("[unresolved]");
    expect(html).toContain('<a href="/wiki/lessons/c">');
    expect(html).toContain('<a href="/wiki/projects/d">');
    expect(html).toContain("via wikilink");
    expect(html).toContain("via relation:uses");
  });

  it("renderRawSession escapes HTML in raw content", () => {
    const html = renderRawSession({
      date: "2026-05-23",
      filename: "raw.md",
      content: "<script>alert('x')</script>",
      sizeBytes: 27,
    });

    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('x')</script>");
  });

  it("Updated renderHomepage includes nav links to /wiki/, /raw/, /log", () => {
    const html = renderHomepage(fixture());

    expect(html).toContain('<a href="/wiki/">');
    expect(html).toContain('<a href="/raw/">');
    expect(html).toContain('<a href="/log">');
  });
});
