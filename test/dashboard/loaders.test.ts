import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileStatePath, writeCompileStateFile } from "../../src/compile/state.js";
import {
  createRawCaptureEventCache,
  loadCompileState,
  loadConflicts,
  loadCounts,
  loadLastCompile,
  loadLogTail,
  loadMaintenanceScan,
  loadPageDetail,
  loadRawCaptureEvents,
  loadRawIndex,
  loadTimelineFeed,
  redactConfig,
  loadSyncState,
  loadWikiIndex,
  timelineLaneForEvent,
} from "../../src/dashboard/loaders.js";

function page(frontmatter: Record<string, unknown>, body: string): string {
  const lines = Object.entries(frontmatter).flatMap(([key, value]) => {
    if (Array.isArray(value)) {
      return [`${key}:`, ...value.map((item) => `  - ${item}`)];
    }
    if (typeof value === "object" && value !== null) {
      return [
        `${key}:`,
        ...Object.entries(value as Record<string, unknown>).flatMap(([childKey, childValue]) => [
          ...(Array.isArray(childValue)
            ? [`  ${childKey}:`, ...childValue.map((item) => `    - ${item}`)]
            : [`  ${childKey}: ${childValue}`]),
        ]),
      ];
    }
    return [`${key}: ${value}`];
  });
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

describe("dashboard loaders", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "dash-loaders-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("loadCounts returns zero for an empty vault", async () => {
    await mkdir(join(tmp, "wiki"), { recursive: true });
    await mkdir(join(tmp, "raw"), { recursive: true });
    await mkdir(join(tmp, "crystals"), { recursive: true });

    await expect(loadCounts(tmp)).resolves.toEqual({
      wikiPages: 0,
      rawObservations: 0,
      crystals: 0,
    });
  });

  it("loadCounts counts .md files across all three trees, ignoring other extensions", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await mkdir(join(tmp, "raw", "2026-05-23"), { recursive: true });
    await mkdir(join(tmp, "crystals"), { recursive: true });
    await writeFile(join(tmp, "wiki", "a.md"), "# A\n");
    await writeFile(join(tmp, "wiki", "projects", "b.md"), "# B\n");
    await writeFile(join(tmp, "wiki", "ignore.txt"), "nope\n");
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(tmp, "raw", "2026-05-23", `${i}.md`), `raw ${i}\n`);
    }

    await expect(loadCounts(tmp)).resolves.toEqual({
      wikiPages: 2,
      rawObservations: 5,
      crystals: 0,
    });
  });

  it("redactConfig redacts secret-named strings anywhere while preserving non-secret settings", () => {
    const raw = {
      voyage: {
        api_key: "voyage-secret",
        dim: 2048,
      },
      llm: {
        api_key: "llm-secret",
        model: "openai/gpt-4o-mini",
        max_tokens: 4096,
        options: {
          access_token: "nested-token",
          temperature: 0.2,
        },
      },
      openrouter: {
        api_key: "openrouter-secret",
      },
      providers: [
        {
          name: "provider-a",
          secret: "array-secret",
        },
      ],
      apiKey: "camel-secret",
      cadence: "weekly",
    };

    expect(redactConfig(raw)).toEqual({
      voyage: {
        api_key: "[REDACTED]",
        dim: 2048,
      },
      llm: {
        api_key: "[REDACTED]",
        model: "openai/gpt-4o-mini",
        max_tokens: 4096,
        options: {
          access_token: "[REDACTED]",
          temperature: 0.2,
        },
      },
      openrouter: {
        api_key: "[REDACTED]",
      },
      providers: [
        {
          name: "provider-a",
          secret: "[REDACTED]",
        },
      ],
      apiKey: "[REDACTED]",
      cadence: "weekly",
    });
  });

  it("loadLastCompile returns the most recent compile line", async () => {
    await writeFile(
      join(tmp, "log.md"),
      [
        "## [2026-05-21 10:00:00] compile | older",
        "other line",
        "## [2026-05-22 11:00:00] compile | newest",
        "",
      ].join("\n"),
    );

    await expect(loadLastCompile(tmp)).resolves.toEqual({
      timestamp: "2026-05-22 11:00:00",
      line: "## [2026-05-22 11:00:00] compile | newest",
    });
  });

  it("loadSyncState returns null when missing and parses valid JSON when present", async () => {
    await expect(loadSyncState(tmp)).resolves.toBeNull();
    await writeFile(
      join(tmp, ".sync-state.json"),
      JSON.stringify({
        last_sync_attempt: "2026-05-23T00:00:00.000Z",
        last_sync_success: "2026-05-23T00:00:00.000Z",
        pending_push_count: 0,
        conflicts_pending: 0,
        conflict_files: [],
      }),
    );

    await expect(loadSyncState(tmp)).resolves.toEqual({
      lastSyncAttempt: "2026-05-23T00:00:00.000Z",
      lastSyncSuccess: "2026-05-23T00:00:00.000Z",
      pendingPushCount: 0,
      conflictsPending: 0,
      conflictFiles: [],
      lastCheckoutAt: "2026-05-23T00:00:00.000Z",
      isStale: false,
    });
  });

  it("loadSyncState suppresses a stale conflict flag when git has no unmerged paths", async () => {
    await writeFile(
      join(tmp, ".sync-state.json"),
      JSON.stringify({
        last_sync_attempt: "2026-06-17T00:00:00.000Z",
        last_sync_success: null,
        pending_push_count: 0,
        conflicts_pending: 2,
        conflict_files: ["wiki/a.md", "wiki/b.md"],
      }),
    );
    const runGit = async () => "";

    const state = await loadSyncState(tmp, runGit);
    expect(state?.conflictsPending).toBe(0);
    expect(state?.conflictFiles).toEqual([]);
  });

  it("loadSyncState keeps the conflict when git reports unmerged paths", async () => {
    await writeFile(
      join(tmp, ".sync-state.json"),
      JSON.stringify({
        last_sync_attempt: "2026-06-17T00:00:00.000Z",
        last_sync_success: null,
        pending_push_count: 0,
        conflicts_pending: 2,
        conflict_files: ["wiki/a.md", "wiki/b.md"],
      }),
    );
    const runGit = async () => "100644 abc123 1\twiki/a.md\n100644 def456 1\twiki/b.md\n";

    const state = await loadSyncState(tmp, runGit);
    expect(state?.conflictsPending).toBe(2);
    expect(state?.conflictFiles).toEqual(["wiki/a.md", "wiki/b.md"]);
  });

  it("loadSyncState keeps the recorded conflict when git errors", async () => {
    await writeFile(
      join(tmp, ".sync-state.json"),
      JSON.stringify({
        last_sync_attempt: "2026-06-17T00:00:00.000Z",
        last_sync_success: null,
        pending_push_count: 0,
        conflicts_pending: 1,
        conflict_files: ["wiki/a.md"],
      }),
    );
    const runGit = async () => {
      throw new Error("not a git repository");
    };

    const state = await loadSyncState(tmp, runGit);
    expect(state?.conflictsPending).toBe(1);
    expect(state?.conflictFiles).toEqual(["wiki/a.md"]);
  });

  it("loadCompileState returns idle when the state file is missing", async () => {
    await expect(loadCompileState(tmp)).resolves.toEqual({ status: "idle", lastRun: null });
  });

  it("loadCompileState parses compile state with a completed last run", async () => {
    const lastRun = {
      startedAt: "2026-05-24T10:00:00.000Z",
      finishedAt: "2026-05-24T10:00:04.250Z",
      durationMs: 4250,
      pagesCompiled: 12,
      digestPath: "wiki/crystal/compile-2026-05-24.md",
    };
    await writeCompileStateFile(tmp, { status: "completed", lastRun });

    await expect(loadCompileState(tmp)).resolves.toEqual({ status: "completed", lastRun });
  });

  it("loadCompileState returns idle when compile state is malformed", async () => {
    await mkdir(join(tmp, "var", "compile"), { recursive: true });
    await writeFile(compileStatePath(tmp), "{ not json");

    await expect(loadCompileState(tmp)).resolves.toEqual({ status: "idle", lastRun: null });
  });

  it("loadConflicts returns an empty list when the store is missing and parses an array-shaped store", async () => {
    await expect(loadConflicts(tmp)).resolves.toEqual({ conflicts: [] });

    await mkdir(join(tmp, "state"), { recursive: true });
    const validConflict = {
      id: "conflict-1",
      reason: "contradiction",
      pageA: {
        path: "wiki/decisions/a.md",
        title: "A",
        updated: "2026-05-22",
        snippet: "A says to keep the old path.",
      },
      pageB: {
        path: "wiki/lessons/b.md",
        title: "B",
        updated: null,
        snippet: "B says the new path is required.",
      },
    };
    await writeFile(
      join(tmp, "state", "conflicts.json"),
      JSON.stringify([validConflict], null, 2),
    );

    await expect(loadConflicts(tmp)).resolves.toEqual({ conflicts: [validConflict] });
  });

  it("loadConflicts accepts object-shaped stores and filters invalid records", async () => {
    await mkdir(join(tmp, "state"), { recursive: true });
    const validConflict = {
      id: "conflict-2",
      reason: "duplicate-title",
      pageA: {
        path: "wiki/projects/a.md",
        title: "A",
        updated: "2026-05-22",
        snippet: "A project page.",
      },
      pageB: {
        path: "wiki/projects/b.md",
        title: "B",
        updated: "2026-05-23",
        snippet: "B project page.",
      },
    };
    await writeFile(
      join(tmp, "state", "conflicts.json"),
      JSON.stringify(
        {
          conflicts: [
            validConflict,
            { ...validConflict, id: 42 },
            { ...validConflict, reason: "unsupported-reason" },
            { ...validConflict, pageB: { title: "missing path" } },
          ],
        },
        null,
        2,
      ),
    );

    await expect(loadConflicts(tmp)).resolves.toEqual({ conflicts: [validConflict] });
  });

  it("loadConflicts parses derived contradiction records", async () => {
    await mkdir(join(tmp, "state"), { recursive: true });
    const derivedConflict = {
      id: "contradiction:a:b:dependent:projects/c.md",
      reason: "derived-from-contradiction",
      dependentPath: "wiki/projects/c.md",
      via: ["decisions/a.md:derived_from", "projects/c.md:linked"],
      rootContradictionId: "contradiction:a:b",
    };
    await writeFile(
      join(tmp, "state", "conflicts.json"),
      JSON.stringify([derivedConflict], null, 2),
    );

    await expect(loadConflicts(tmp)).resolves.toEqual({ conflicts: [derivedConflict] });
  });

  it("loadMaintenanceScan classifies orphan, low-confidence, and stale pages with an injected clock", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await mkdir(join(tmp, "wiki", "decisions"), { recursive: true });
    await mkdir(join(tmp, "wiki", "lessons"), { recursive: true });
    await mkdir(join(tmp, "wiki", "references"), { recursive: true });
    await mkdir(join(tmp, "wiki", "tools"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "linked.md"),
      page(
        {
          type: "projects",
          title: "Linked",
          created: "2026-05-20",
          updated: "2026-05-23",
          status: "active",
          confidence: 0.9,
          relations: { uses: ["tools/helper"] },
        },
        "Linked body.\n",
      ),
    );
    await writeFile(
      join(tmp, "wiki", "tools", "helper.md"),
      page(
        {
          type: "tools",
          title: "Helper",
          created: "2026-05-20",
          updated: "2026-05-23",
          status: "active",
          confidence: 0.8,
        },
        "Helper body.\n",
      ),
    );
    await writeFile(
      join(tmp, "wiki", "lessons", "orphan.md"),
      page(
        {
          type: "lessons",
          title: "Orphan",
          created: "2026-05-20",
          updated: "2026-05-23",
          status: "active",
          confidence: 0.9,
        },
        "Standalone body with no wiki links.\n",
      ),
    );
    await writeFile(
      join(tmp, "wiki", "references", "low.md"),
      page(
        {
          type: "references",
          title: "Low Confidence",
          created: "2026-05-20",
          updated: "2026-05-23",
          status: "active",
          confidence: 0.55,
        },
        "Low confidence body references [[projects/linked]].\n",
      ),
    );
    await writeFile(
      join(tmp, "wiki", "projects", "stale.md"),
      page(
        {
          type: "projects",
          title: "Stale Page",
          created: "2024-12-01",
          updated: "2025-11-24",
          status: "active",
          confidence: 0.9,
        },
        "Stale body references [[projects/linked]].\n",
      ),
    );
    await writeFile(
      join(tmp, "wiki", "decisions", "old.md"),
      page(
        {
          type: "decisions",
          title: "Old Decision",
          created: "2026-05-20",
          updated: "2026-05-20",
          status: "superseded",
          confidence: 0.9,
        },
        "Old body.\n",
      ),
    );
    await writeFile(
      join(tmp, "wiki", "projects", "dependent.md"),
      page(
        {
          type: "projects",
          title: "Dependent",
          created: "2026-05-20",
          updated: "2026-05-23",
          status: "active",
          confidence: 0.9,
          relations: { depends_on: ["decisions/old"] },
        },
        "Dependent body references a superseded decision.\n",
      ),
    );

    const scan = await loadMaintenanceScan(tmp, new Date("2026-05-24T00:00:00.000Z"));

    expect(scan).toEqual({
      orphans: [{ path: "wiki/lessons/orphan.md", title: "Orphan", updated: "2026-05-23", confidence: 0.9 }],
      lowConfidence: [
        { path: "wiki/references/low.md", title: "Low Confidence", updated: "2026-05-23", confidence: 0.55 },
      ],
      stale: [{ path: "wiki/projects/stale.md", title: "Stale Page", updated: "2025-11-24", confidence: 0.9 }],
      supersededDependents: [
        { path: "wiki/projects/dependent.md", title: "Dependent", updated: "2026-05-23", confidence: 0.9 },
      ],
      pruneCandidates: [],
    });
  });

  it("loadMaintenanceScan classifies vector confidence by scalar score", async () => {
    await mkdir(join(tmp, "wiki", "references"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "references", "low-vector.md"),
      page(
        {
          type: "references",
          title: "Low Vector",
          created: "2026-05-20",
          updated: "2026-05-23",
          status: "active",
          confidence: { extraction: 0.55 },
        },
        "Low confidence vector body.\n",
      ),
    );

    const scan = await loadMaintenanceScan(tmp, new Date("2026-05-24T00:00:00.000Z"));

    expect(scan.lowConfidence).toContainEqual({
      path: "wiki/references/low-vector.md",
      title: "Low Vector",
      updated: "2026-05-23",
      confidence: 0.55,
    });
  });

  it("loadWikiIndex groups pages by category and sorts", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await mkdir(join(tmp, "wiki", "decisions"), { recursive: true });
    await mkdir(join(tmp, "wiki", "lessons"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "zeta.md"),
      page({ type: "projects", title: "Zeta", created: "2026-05-21", updated: "2026-05-22" }, "Zeta summary.\n"),
    );
    await writeFile(
      join(tmp, "wiki", "projects", "alpha.md"),
      page({ type: "projects", title: "Alpha", created: "2026-05-21", updated: "2026-05-23" }, "Alpha summary.\n"),
    );
    await writeFile(
      join(tmp, "wiki", "decisions", "beta.md"),
      page({ type: "decisions", title: "Beta", created: "2026-05-21", updated: "2026-05-23" }, "Beta summary.\n"),
    );
    await writeFile(
      join(tmp, "wiki", "decisions", "delta.md"),
      page({ type: "decisions", title: "Delta", created: "2026-05-21", updated: "2026-05-22" }, "Delta summary.\n"),
    );
    await writeFile(
      join(tmp, "wiki", "lessons", "one.md"),
      page({ type: "lessons", title: "One", created: "2026-05-21", updated: "2026-05-21" }, "One summary.\n"),
    );

    const index = await loadWikiIndex(tmp);

    expect(index.total).toBe(5);
    expect(Object.keys(index.byCategory)).toEqual(["decisions", "lessons", "projects"]);
    expect(index.byCategory.projects).toHaveLength(2);
    expect(index.byCategory.projects.map((entry) => entry.slug)).toEqual(["alpha", "zeta"]);
  });

  it("loadWikiIndex excludes wiki dot-directories", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await mkdir(join(tmp, "wiki", ".audit"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "visible.md"),
      page({ type: "projects", title: "Visible", created: "2026-05-21", updated: "2026-05-23" }, "Visible summary.\n"),
    );
    await writeFile(
      join(tmp, "wiki", ".audit", "llm-2026-05-29.md"),
      page({ type: "references", title: "Audit Log", created: "2026-05-29", updated: "2026-05-29" }, "Audit summary.\n"),
    );

    const index = await loadWikiIndex(tmp);

    expect(index.total).toBe(1);
    expect(JSON.stringify(index)).not.toContain(".audit");
    expect(JSON.stringify(index)).not.toContain("Audit Log");
  });

  it("loadPageDetail resolves relations and inbound references", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await mkdir(join(tmp, "wiki", "lessons"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "a.md"),
      page(
        {
          type: "projects",
          title: "A",
          created: "2026-05-21",
          updated: "2026-05-23",
          relations: { uses: ["b"] },
        },
        "A body.\n",
      ),
    );
    await writeFile(
      join(tmp, "wiki", "projects", "b.md"),
      page({ type: "projects", title: "B", created: "2026-05-21", updated: "2026-05-23" }, "B body.\n"),
    );
    await writeFile(
      join(tmp, "wiki", "lessons", "c.md"),
      page({ type: "lessons", title: "C", created: "2026-05-21", updated: "2026-05-23" }, "Links to [[A]].\n"),
    );

    const detail = await loadPageDetail(tmp, "projects/a.md");

    expect(detail?.relations[0]).toMatchObject({
      key: "uses",
      target: "b",
      resolvedPath: "projects/b.md",
      resolvedTitle: "B",
    });
    expect(detail?.inbound).toContainEqual({
      fromPath: "lessons/c.md",
      fromTitle: "C",
      via: "wikilink",
    });
  });

  it("loadPageDetail returns null for non-existent paths", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });

    await expect(loadPageDetail(tmp, "projects/ghost.md")).resolves.toBeNull();
  });

  it("loadPageDetail rejects wiki dot-directory paths", async () => {
    await mkdir(join(tmp, "wiki", ".audit"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", ".audit", "llm-2026-05-29.md"),
      page({ type: "references", title: "Audit Log", created: "2026-05-29", updated: "2026-05-29" }, "Audit body.\n"),
    );

    await expect(loadPageDetail(tmp, ".audit/llm-2026-05-29.md")).resolves.toBeNull();
  });

  it("loadRawIndex walks the raw tree", async () => {
    await mkdir(join(tmp, "raw", "2026-05-21"), { recursive: true });
    await mkdir(join(tmp, "raw", "2026-05-22"), { recursive: true });
    await writeFile(join(tmp, "raw", "2026-05-21", "foo.md"), "foo\n");
    await writeFile(join(tmp, "raw", "2026-05-21", "bar.md"), "bar\n");
    await writeFile(join(tmp, "raw", "2026-05-22", "baz.md"), "baz\n");

    const entries = await loadRawIndex(tmp);

    expect(entries.map((entry) => entry.date)).toEqual(["2026-05-22", "2026-05-21"]);
    expect(entries[0]?.files).toHaveLength(1);
    expect(entries[1]?.files).toHaveLength(2);
  });

  it("loadRawCaptureEvents emits one event per raw file with source and mtime", async () => {
    await writeRawCapture("2026-05-01", "claude-code-agent-sub.md", "2026-06-04T08:00:00.000Z");
    await writeRawCapture("2026-06-04", "codex-main.md", "2026-06-04T09:00:00.000Z");
    await writeRawCapture("2026-06-04", "antigravity-session.md", "2026-06-04T10:00:00.000Z");
    await writeRawCapture("2026-06-04", "claude-desktop-desktop.md", "2026-06-04T11:00:00.000Z");
    await writeRawCapture("2026-06-04", "manual-mcp-note.md", "2026-06-04T12:00:00.000Z");
    await writeRawCapture("2026-06-04", "mystery-note.md", "2026-06-04T13:00:00.000Z");

    const events = await loadRawCaptureEvents(tmp, {
      from: new Date("2026-06-04T00:00:00.000Z"),
      to: new Date("2026-06-05T00:00:00.000Z"),
    });

    expect(events.map((event) => [event.source, event.timestamp, event.details?.["relPath"]])).toEqual([
      ["manual", "2026-06-04T13:00:00.000Z", "raw/2026-06-04/mystery-note.md"],
      ["manual", "2026-06-04T12:00:00.000Z", "raw/2026-06-04/manual-mcp-note.md"],
      ["claude-desktop", "2026-06-04T11:00:00.000Z", "raw/2026-06-04/claude-desktop-desktop.md"],
      ["antigravity", "2026-06-04T10:00:00.000Z", "raw/2026-06-04/antigravity-session.md"],
      ["codex", "2026-06-04T09:00:00.000Z", "raw/2026-06-04/codex-main.md"],
      ["claude-code", "2026-06-04T08:00:00.000Z", "raw/2026-05-01/claude-code-agent-sub.md"],
    ]);
  });

  it("timelineLaneForEvent routes client captures to their lanes and legacy activity to manual", () => {
    expect(timelineLaneForEvent(activityEvent("claude-code"))).toBe("claude-code");
    expect(timelineLaneForEvent(activityEvent("codex"))).toBe("codex");
    expect(timelineLaneForEvent(activityEvent("antigravity"))).toBe("antigravity");
    expect(timelineLaneForEvent(activityEvent("claude-desktop"))).toBe("claude-desktop");
    expect(timelineLaneForEvent(activityEvent("compile"))).toBe("compile");
    expect(timelineLaneForEvent(activityEvent("lint"))).toBe("lint");
    expect(timelineLaneForEvent(activityEvent("sync"))).toBe("sync");
    expect(timelineLaneForEvent(activityEvent("git"))).toBe("manual");
    expect(timelineLaneForEvent(activityEvent("errors"))).toBe("manual");
    expect(timelineLaneForEvent(activityEvent("manual"))).toBe("manual");
  });

  it("loadRawCaptureEvents refreshes only changed raw directories when cached", async () => {
    await writeRawCapture("2026-06-03", "codex-old.md", "2026-06-04T08:00:00.000Z");
    await writeRawCapture("2026-06-04", "claude-code-new.md", "2026-06-04T09:00:00.000Z");
    const cache = createRawCaptureEventCache();
    const window = {
      from: new Date("2026-06-04T00:00:00.000Z"),
      to: new Date("2026-06-05T00:00:00.000Z"),
    };

    await loadRawCaptureEvents(tmp, { ...window, cache });
    await loadRawCaptureEvents(tmp, { ...window, cache });
    await utimes(
      join(tmp, "raw", "2026-06-03", "codex-old.md"),
      new Date("2026-06-04T10:00:00.000Z"),
      new Date("2026-06-04T10:00:00.000Z"),
    );
    const events = await loadRawCaptureEvents(tmp, { ...window, cache });

    expect(events[0]).toMatchObject({
      source: "codex",
      timestamp: "2026-06-04T10:00:00.000Z",
    });
    expect(cache.stats.directoryRefreshes).toBe(3);
    expect(cache.stats.directoryCacheHits).toBe(3);
  });

  it("loadTimelineFeed includes raw captures in lanes and velocity buckets", async () => {
    await writeRawCapture("2026-06-04", "claude-code-a.md", "2026-06-04T08:00:00.000Z");
    await writeRawCapture("2026-06-04", "codex-b.md", "2026-06-04T09:00:00.000Z");
    await writeRawCapture("2026-06-04", "claude-desktop-c.md", "2026-06-04T10:00:00.000Z");

    const feed = await loadTimelineFeed(tmp, {
      from: new Date("2026-06-04T00:00:00.000Z"),
      to: new Date("2026-06-05T00:00:00.000Z"),
      zoom: "1D",
      rawCaptureCache: createRawCaptureEventCache(),
    });

    expect(feed.lanes.find((lane) => lane.lane === "claude-code")?.events).toHaveLength(1);
    expect(feed.lanes.find((lane) => lane.lane === "codex")?.events).toHaveLength(1);
    expect(feed.lanes.find((lane) => lane.lane === "claude-desktop")?.events).toHaveLength(1);
    expect(feed.velocity).toEqual([{ bucket: "2026-06-04T00:00:00.000Z", count: 3 }]);
  });

  it("loadLogTail returns last N lines", async () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
    await writeFile(join(tmp, "log.md"), `${lines.join("\n")}\n`);

    const tail = await loadLogTail(tmp, 50);

    expect(tail.lines).toHaveLength(50);
    expect(tail.totalLines).toBe(200);
    expect(tail.lines.at(-1)).toBe("line 200");
  });

  async function writeRawCapture(date: string, filename: string, mtimeIso: string): Promise<void> {
    const dir = join(tmp, "raw", date);
    const fullPath = join(dir, filename);
    const mtime = new Date(mtimeIso);
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, `# ${filename}\n`);
    await utimes(fullPath, mtime, mtime);
  }
});

function activityEvent(source: Parameters<typeof timelineLaneForEvent>[0]["source"]): Parameters<typeof timelineLaneForEvent>[0] {
  return {
    timestamp: "2026-06-04T00:00:00.000Z",
    source,
    level: "info",
    summary: source,
  };
}
