import { describe, expect, it } from "vitest";
import type { DashboardStatus } from "../../src/dashboard/loaders.js";
import { renderHomepage } from "../../src/dashboard/render.js";

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
});
