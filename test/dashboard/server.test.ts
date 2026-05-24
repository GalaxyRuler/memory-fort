import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardStatus } from "../../src/dashboard/loaders.js";
import { createServer } from "../../src/dashboard/server.js";
import type { VoyageClient } from "../../src/retrieval/voyage-client.js";

function fixture(): DashboardStatus {
  return {
    vaultRoot: "/root/memory-system/vault",
    repoHead: {
      sha: "abcdef1234567890",
      shortSha: "abcdef1",
      subject: "curated memory update",
      committedAt: "2026-05-23T01:00:00.000Z",
    },
    counts: { wikiPages: 12, rawObservations: 19, crystals: 0 },
    lastCompile: null,
    errorsLog: { sizeBytes: 0, lastLine: null, isClean: true },
    syncState: null,
    generatedAt: "2026-05-23T01:10:00.000Z",
  };
}

function page(frontmatter: Record<string, unknown>, body: string): string {
  const lines = Object.entries(frontmatter).flatMap(([key, value]) => {
    if (Array.isArray(value)) {
      return [`${key}:`, ...value.map((item) => `  - ${item}`)];
    }
    if (typeof value === "object" && value !== null) {
      return [
        `${key}:`,
        ...Object.entries(value as Record<string, unknown>).flatMap(([childKey, childValue]) => [
          `  ${childKey}:`,
          ...(Array.isArray(childValue) ? childValue.map((item) => `    - ${item}`) : [`    - ${childValue}`]),
        ]),
      ];
    }
    return [`${key}: ${value}`];
  });
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

function mockVoyageClient(): VoyageClient {
  return {
    embed: vi.fn(async (texts: string[]) => ({
      vectors: texts.map((text) =>
        text.toLowerCase().includes("foo") ? [1, 0, 0] : [0, 1, 0],
      ),
      model: "test-embed",
      dim: 3,
    })),
    rerank: vi.fn(async (_query, documents) => ({
      ranked: documents.map((document, index) => ({
        index,
        score: 1 - index * 0.01,
        document,
      })),
      model: "test-rerank",
    })),
  };
}

async function writeSearchWiki(root: string, count = 3): Promise<void> {
  await mkdir(join(root, "wiki", "projects"), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await writeFile(
      join(root, "wiki", "projects", `foo-${index}.md`),
      page(
        {
          type: "projects",
          title: `Foo ${index}`,
          status: "active",
          confidence: "0.9",
          tags: "[foo]",
          created: "2026-05-21",
          updated: "2026-05-23",
        },
        `Foo body content ${index}. This page mentions foo search.\n`,
      ),
    );
  }
}

async function writeActivityLog(root: string): Promise<void> {
  await writeFile(
    join(root, "log.md"),
    [
      "## [2026-05-24T12:00:00.000Z] compile | latest compile",
      "",
      "Compile completed.",
      "",
      "## [2026-05-23T11:00:00.000Z] sync | middle sync",
      "",
      "Sync completed.",
      "",
      "## [2026-05-22T10:00:00.000Z] lint | old lint",
      "",
      "Lint completed.",
      "",
    ].join("\n"),
  );
}

async function writeDashboardDist(root: string): Promise<string> {
  const distRoot = join(root, "dist", "dashboard-ui");
  await mkdir(join(distRoot, "assets"), { recursive: true });
  await writeFile(
    join(distRoot, "index.html"),
    '<!doctype html><html><head><title>Memory</title><script type="module" src="/memory/assets/app-123.js"></script></head><body><div id="root"></div></body></html>',
  );
  await writeFile(join(distRoot, "assets", "app-123.js"), "console.log('dashboard asset');\n");
  await writeFile(join(distRoot, "assets", "style-123.css"), "body{color:white}\n");
  return distRoot;
}

describe("dashboard server", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "dash-server-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("GET /healthz returns 200 text/plain ok", async () => {
    let loaderCalled = false;
    const server = await createServer({
      vaultRoot: "/unused",
      port: 0,
      loader: async () => {
        loaderCalled = true;
        return fixture();
      },
    });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/healthz`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      await expect(response.text()).resolves.toBe("ok");
      expect(loaderCalled).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("GET / returns 200 HTML with the loader's data rendered", async () => {
    const server = await createServer({
      vaultRoot: "/unused",
      port: 0,
      loader: async () => fixture(),
    });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      await expect(response.text()).resolves.toContain("abcdef1234567890");
    } finally {
      await server.close();
    }
  });

  it("GET /api/status returns 200 JSON matching the loader output", async () => {
    const status = fixture();
    const server = await createServer({
      vaultRoot: "/unused",
      port: 0,
      loader: async () => status,
    });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/status`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toEqual(status);
    } finally {
      await server.close();
    }
  });

  it("GET /wiki/ returns 200 HTML with category sections", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await mkdir(join(tmp, "wiki", "decisions"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "foo.md"),
      page({ type: "projects", title: "Foo", created: "2026-05-21", updated: "2026-05-23" }, "Foo body.\n"),
    );
    await writeFile(
      join(tmp, "wiki", "decisions", "bar.md"),
      page({ type: "decisions", title: "Bar", created: "2026-05-21", updated: "2026-05-23" }, "Bar body.\n"),
    );
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/wiki/`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(body).toContain("Wiki");
      expect(body).toContain("projects");
      expect(body).toContain("decisions");
    } finally {
      await server.close();
    }
  });

  it("GET /wiki/<category>/<slug> returns 200 HTML with page body", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "foo.md"),
      page({ type: "projects", title: "Foo", created: "2026-05-21", updated: "2026-05-23" }, "Foo page content.\n"),
    );
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/wiki/projects/foo`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(body).toContain("Foo page content.");
    } finally {
      await server.close();
    }
  });

  it("GET /wiki/projects/ghost returns 404", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/wiki/projects/ghost`);
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(body).toContain("Not found");
    } finally {
      await server.close();
    }
  });

  it("Path traversal blocked: GET /wiki/..%2Fbar/foo returns 400", async () => {
    const server = await createServer({ vaultRoot: join(tmp, "missing-vault"), port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/wiki/..%2Fbar/foo`);
      const body = await response.text();
      expect(response.status).toBe(400);
      expect(body).toContain("Bad Request");
    } finally {
      await server.close();
    }
  });

  it("GET /api/log?lines=10 returns JSON with 10 lines", async () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
    await writeFile(join(tmp, "log.md"), `${lines.join("\n")}\n`);
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/log?lines=10`);
      const body = (await response.json()) as { lines: string[] };
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.lines).toHaveLength(10);
    } finally {
      await server.close();
    }
  });

  it("GET /api/search?q=foo returns 200 JSON with results", async () => {
    await writeSearchWiki(tmp);
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      voyageClient: mockVoyageClient(),
    });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/search?q=foo`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body).toEqual({
        query: "foo",
        results: expect.any(Array),
        warnings: expect.any(Array),
        timings: expect.any(Object),
        degraded: expect.any(Boolean),
        hyde: expect.any(Object),
        corpusErrorCount: expect.any(Number),
      });
      expect(body.results.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("GET /api/search without q returns 400", async () => {
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/search`);
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.error).toBe("missing query parameter q");
    } finally {
      await server.close();
    }
  });

  it("GET /api/search?q=foo works with null voyageClient in degraded mode", async () => {
    await writeSearchWiki(tmp);
    const server = await createServer({ vaultRoot: tmp, port: 0, voyageClient: null });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/search?q=foo`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.degraded).toBe(true);
      expect(body.results.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("GET /api/search parameter validation clamps k", async () => {
    await writeSearchWiki(tmp, 60);
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      voyageClient: mockVoyageClient(),
    });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/search?q=foo&k=999`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.results.length).toBeLessThanOrEqual(50);
    } finally {
      await server.close();
    }
  });

  it("GET /api/page/:relpath returns 200 JSON for an existing page", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "foo.md"),
      page(
        { type: "projects", title: "Foo", status: "active", confidence: "0.9", updated: "2026-05-23" },
        "Foo page content.\n",
      ),
    );
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const relPath = encodeURIComponent("wiki/projects/foo.md");
      const response = await fetch(`http://${server.host}:${server.port}/api/page/${relPath}`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body).toEqual({
        relPath: "wiki/projects/foo.md",
        fullPath: expect.stringContaining("foo.md"),
        frontmatter: expect.objectContaining({ title: "Foo", type: "projects" }),
        body: expect.stringContaining("Foo page content."),
        relations: expect.any(Array),
        inbound: expect.any(Array),
      });
    } finally {
      await server.close();
    }
  });

  it("GET /api/page/:relpath returns 404 for a non-existent page", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const relPath = encodeURIComponent("wiki/projects/ghost.md");
      const response = await fetch(`http://${server.host}:${server.port}/api/page/${relPath}`);
      const body = await response.json();
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.error).toContain("not found");
    } finally {
      await server.close();
    }
  });

  it("GET /api/raw/:date/:filename returns 200 JSON for an existing session", async () => {
    await mkdir(join(tmp, "raw", "2026-05-24"), { recursive: true });
    const filename = "claude-code-019e4bf7-d7b8-4a57.md";
    await writeFile(
      join(tmp, "raw", "2026-05-24", filename),
      page({ source: "claude-code", tool: "capture" }, "# Session\n\nRaw body content.\n"),
    );
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/raw/2026-05-24/${filename}`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body).toEqual({
        date: "2026-05-24",
        filename,
        fullPath: expect.stringContaining(filename),
        source: "claude-code",
        sessionId: "019e4bf7-d7b8-4a57",
        sizeBytes: expect.any(Number),
        mtime: expect.any(String),
        body: expect.stringContaining("Raw body content."),
        frontmatter: expect.objectContaining({ source: "claude-code", tool: "capture" }),
      });
      expect(body.sizeBytes).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(body.mtime))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("GET /api/raw/:date/:filename returns 404 JSON when session does not exist", async () => {
    await mkdir(join(tmp, "raw", "2026-05-24"), { recursive: true });
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/raw/2026-05-24/missing.md`);
      const body = await response.json();
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.error).toContain("session not found");
    } finally {
      await server.close();
    }
  });

  it("GET /api/activity returns 200 JSON with newest events first", async () => {
    await writeActivityLog(tmp);
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/activity?limit=10`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.events.map((event: { timestamp: string }) => event.timestamp)).toEqual([
        "2026-05-24T12:00:00.000Z",
        "2026-05-23T11:00:00.000Z",
        "2026-05-22T10:00:00.000Z",
      ]);
      expect(body.events[0]).toMatchObject({
        source: "compile",
        level: "info",
        summary: "latest compile",
      });
      expect(body.nextCursor).toBe("2026-05-22T10:00:00.000Z");
    } finally {
      await server.close();
    }
  });

  it("GET /api/activity respects cursor for pagination", async () => {
    await writeActivityLog(tmp);
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const cursor = encodeURIComponent("2026-05-23T11:00:00.000Z");
      const response = await fetch(`http://${server.host}:${server.port}/api/activity?cursor=${cursor}&limit=10`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.events).toHaveLength(1);
      expect(body.events[0].timestamp).toBe("2026-05-22T10:00:00.000Z");
    } finally {
      await server.close();
    }
  });

  it("GET /api/timeline returns lanes bucketed correctly", async () => {
    await writeActivityLog(tmp);
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(
        `http://${server.host}:${server.port}/api/timeline?zoom=1D&from=2026-05-22T00:00:00.000Z&to=2026-05-25T00:00:00.000Z`,
      );
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.lanes).toHaveLength(7);
      expect(body.lanes.map((lane: { lane: string }) => lane.lane)).toEqual([
        "claude-code",
        "codex",
        "antigravity",
        "manual",
        "compile",
        "lint",
        "sync",
      ]);
      expect(body.lanes.find((lane: { lane: string }) => lane.lane === "compile").events).toHaveLength(1);
      expect(body.velocity.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("GET /api/timeline rejects invalid zoom value", async () => {
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/timeline?zoom=foo`);
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.error).toContain("zoom");
    } finally {
      await server.close();
    }
  });

  it("GET /api/graph returns nodes and edges for a wiki scope", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await mkdir(join(tmp, "wiki", "tools"), { recursive: true });
    await mkdir(join(tmp, "wiki", "lessons"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "a.md"),
      [
        "---",
        "type: projects",
        "title: A",
        "updated: 2026-05-23",
        "confidence: 0.9",
        "relations:",
        "  uses:",
        "    - b",
        "---",
        "",
        "A links to [[c]].",
      ].join("\n"),
    );
    await writeFile(
      join(tmp, "wiki", "tools", "b.md"),
      page({ type: "tools", title: "B", updated: "2026-05-23", confidence: "0.8" }, "B body.\n"),
    );
    await writeFile(
      join(tmp, "wiki", "lessons", "c.md"),
      page({ type: "lessons", title: "C", updated: "2026-05-23", confidence: "0.7" }, "C body.\n"),
    );
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/graph?scope=wiki`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "wiki/projects/a.md",
            title: "A",
            kind: "wiki",
            type: "projects",
            outboundCount: 2,
          }),
        ]),
      );
      expect(body.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromPath: "wiki/projects/a.md",
            toPath: "wiki/tools/b.md",
            kind: "relation",
            relationType: "uses",
          }),
        ]),
      );
    } finally {
      await server.close();
    }
  });

  it("GET /api/sync-state returns checkout-log-derived state", async () => {
    await mkdir(join(tmp, "logs"), { recursive: true });
    // Use a fixture timestamp anchored to the current clock so the staleness
    // window (6h) never drifts under us. The loader computes status against
    // real Date.now(); a hardcoded ISO date silently flips to "stale" 6 hours
    // after the date in the literal.
    const checkoutAt = new Date(Date.now() - 60_000).toISOString();
    await writeFile(
      join(tmp, "logs", "checkout.log"),
      `${checkoutAt} checked out 747ce8f from creator push\n`,
    );
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/sync-state`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body).toEqual({
        lastCheckoutAt: checkoutAt,
        lastCommit: "747ce8f",
        status: "synced",
      });
    } finally {
      await server.close();
    }
  });

  it("GET /api/compile/state returns idle state JSON on a vault with no compile state", async () => {
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/compile/state`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body).toEqual({ status: "idle", lastRun: null });
    } finally {
      await server.close();
    }
  });

  it("GET /api/conflicts returns an empty list on a clean vault and parses a populated store", async () => {
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const cleanResponse = await fetch(`http://${server.host}:${server.port}/api/conflicts`);
      expect(cleanResponse.status).toBe(200);
      await expect(cleanResponse.json()).resolves.toEqual({ conflicts: [] });

      await mkdir(join(tmp, "state"), { recursive: true });
      const conflict = {
        id: "conflict-1",
        reason: "contradiction",
        pageA: {
          path: "wiki/decisions/database-migration.md",
          title: "Database Migration Strategy",
          updated: "2026-05-22",
          snippet: "Rule: migrate synchronously during the maintenance window.",
        },
        pageB: {
          path: "wiki/lessons/q4-migration-outage.md",
          title: "Post-Mortem: Q4 Migration Outage",
          updated: "2026-05-23",
          snippet: "Finding: asynchronous dual-write avoids long transaction locks.",
        },
      };
      await writeFile(join(tmp, "state", "conflicts.json"), JSON.stringify([conflict], null, 2));

      const populatedResponse = await fetch(`http://${server.host}:${server.port}/api/conflicts`);
      expect(populatedResponse.status).toBe(200);
      await expect(populatedResponse.json()).resolves.toEqual({ conflicts: [conflict] });
    } finally {
      await server.close();
    }
  });

  it("GET /api/maintenance/scan returns orphan, low-confidence, and stale buckets", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
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
        "Standalone body.\n",
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
          created: "2025-01-01",
          updated: "2025-01-01",
          status: "active",
          confidence: 0.9,
        },
        "Stale body references [[projects/linked]].\n",
      ),
    );
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/maintenance/scan`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(Array.isArray(body.orphans)).toBe(true);
      expect(Array.isArray(body.lowConfidence)).toBe(true);
      expect(Array.isArray(body.stale)).toBe(true);
      expect(body.orphans).toContainEqual({
        path: "wiki/lessons/orphan.md",
        title: "Orphan",
        updated: "2026-05-23",
        confidence: 0.9,
      });
      expect(body.lowConfidence).toContainEqual({
        path: "wiki/references/low.md",
        title: "Low Confidence",
        updated: "2026-05-23",
        confidence: 0.55,
      });
      expect(body.stale).toContainEqual({
        path: "wiki/projects/stale.md",
        title: "Stale Page",
        updated: "2025-01-01",
        confidence: 0.9,
      });
    } finally {
      await server.close();
    }
  });

  it("GET /api/config returns parsed config with API key redacted", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "voyage:",
        '  api_key: "real-key-value-here"',
        '  model: "voyage-4-large"',
        "privacy:",
        "  allowlist: []",
        "",
      ].join("\n"),
    );
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/config`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body).toEqual({
        voyage: { api_key: "[REDACTED]", model: "voyage-4-large" },
        privacy: { allowlist: [] },
      });
    } finally {
      await server.close();
    }
  });

  it("GET /api/config returns an empty object when config.yaml is missing", async () => {
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/config`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body).toEqual({});
    } finally {
      await server.close();
    }
  });

  it("GET static asset returns content type and immutable cache-control", async () => {
    const dashboardDistRoot = await writeDashboardDist(tmp);
    const server = await createServer({ vaultRoot: tmp, port: 0, dashboardDistRoot });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/assets/app-123.js`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/javascript");
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(body).toContain("dashboard asset");
    } finally {
      await server.close();
    }
  });

  it("GET index.html returns no-cache", async () => {
    const dashboardDistRoot = await writeDashboardDist(tmp);
    const server = await createServer({ vaultRoot: tmp, port: 0, dashboardDistRoot });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(body).toContain('<div id="root"');
    } finally {
      await server.close();
    }
  });

  it("GET non-API SPA routes fall back to index.html", async () => {
    const dashboardDistRoot = await writeDashboardDist(tmp);
    const server = await createServer({ vaultRoot: tmp, port: 0, dashboardDistRoot });

    try {
      for (const path of ["/wiki", "/graph", "/some/deep/path"]) {
        const response = await fetch(`http://${server.host}:${server.port}${path}`);
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("cache-control")).toBe("no-cache");
        expect(body).toContain('<div id="root"');
      }
    } finally {
      await server.close();
    }
  });

  it("GET path traversal against static handler returns 400", async () => {
    const dashboardDistRoot = await writeDashboardDist(tmp);
    const server = await createServer({ vaultRoot: tmp, port: 0, dashboardDistRoot });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/..%2fetc%2fpasswd`);
      const body = await response.text();
      expect(response.status).toBe(400);
      expect(body).toContain("Bad Request");
    } finally {
      await server.close();
    }
  });

  it("GET /api/status keeps API precedence when static assets are enabled", async () => {
    const dashboardDistRoot = await writeDashboardDist(tmp);
    const status = fixture();
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      dashboardDistRoot,
      loader: async () => status,
    });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/status`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toEqual(status);
    } finally {
      await server.close();
    }
  });
});
