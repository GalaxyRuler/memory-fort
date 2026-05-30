import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardStatus } from "../../src/dashboard/loaders.js";
import { createServer, sameOriginAllowed } from "../../src/dashboard/server.js";
import type { VerifyResult, VerifyRole } from "../../src/cli/commands/verify.js";
import type { VoyageClient } from "../../src/retrieval/voyage-client.js";
import { READ_ONLY_MIRROR_REASON } from "../../src/sync/vault-capability.js";

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
    await mkdir(join(tmp, ".git"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("same-origin guard honors direct, forwarded, missing, and trusted origins", () => {
    const directUrl = new URL("http://127.0.0.1:4410/api/compile/run");
    expect(sameOriginAllowed("http://127.0.0.1:4410", directUrl, { host: "127.0.0.1:4410" })).toBe(true);
    expect(sameOriginAllowed(undefined, directUrl, { host: "127.0.0.1:4410" })).toBe(true);

    expect(sameOriginAllowed("https://srv1317946.tail6916d8.ts.net", directUrl, {
      host: "127.0.0.1:4410",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "srv1317946.tail6916d8.ts.net",
    })).toBe(true);

    expect(sameOriginAllowed("https://evil.example.com", directUrl, {
      host: "127.0.0.1:4410",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "srv1317946.tail6916d8.ts.net",
    })).toBe(false);

    expect(sameOriginAllowed("https://dashboard.example.test", directUrl, {
      host: "127.0.0.1:4410",
    }, ["https://dashboard.example.test"])).toBe(true);
    expect(sameOriginAllowed("https://other.example.test", directUrl, {
      host: "127.0.0.1:4410",
    }, ["https://dashboard.example.test"])).toBe(false);
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
      await expect(response.json()).resolves.toEqual({
        ...status,
        capabilities: {
          writable: false,
          reason: READ_ONLY_MIRROR_REASON,
        },
      });
    } finally {
      await server.close();
    }
  });

  it("GET /api/health returns cached shallow verify JSON with monitor-friendly status", async () => {
    const calls: Array<{ includeSearch?: boolean; role?: VerifyRole; vaultRoot?: string }> = [];
    const report = verifyReport("warn");
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      verifyRunner: async (opts) => {
        calls.push({ includeSearch: opts.includeSearch, role: opts.role, vaultRoot: opts.vaultRoot });
        return report;
      },
    });

    try {
      const first = await fetch(`http://${server.host}:${server.port}/api/health`);
      const second = await fetch(`http://${server.host}:${server.port}/api/health`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      await expect(first.json()).resolves.toEqual(report);
      await expect(second.json()).resolves.toEqual(report);
      expect(calls).toEqual([{ includeSearch: false, role: "operator", vaultRoot: tmp }]);
    } finally {
      await server.close();
    }
  });

  it("GET /api/health?deep=true includes search checks and returns 503 for failures", async () => {
    const calls: Array<{ includeSearch?: boolean; role?: VerifyRole; vaultRoot?: string }> = [];
    const report = verifyReport("fail");
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      verifyRunner: async (opts) => {
        calls.push({ includeSearch: opts.includeSearch, role: opts.role, vaultRoot: opts.vaultRoot });
        return report;
      },
    });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/health?deep=true`);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual(report);
      expect(calls).toEqual([{ includeSearch: true, role: "operator", vaultRoot: tmp }]);
    } finally {
      await server.close();
    }
  });

  it("GET /api/health defaults to the detected role", async () => {
    const previous = process.env["MEMORY_ROLE"];
    process.env["MEMORY_ROLE"] = "server";
    const calls: Array<{ includeSearch?: boolean; role?: VerifyRole }> = [];
    const serverReport = verifyReport("pass", "server", ["vault.read-write", "dashboard.status"]);
    const operatorReport = verifyReport("pass", "operator", ["vault.read-write", "client.codex.config"]);
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      verifyRunner: async (opts) => {
        calls.push({ includeSearch: opts.includeSearch, role: opts.role });
        return opts.role === "server" ? serverReport : operatorReport;
      },
    });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/health`);
      const body = await response.json() as VerifyResult;

      expect(response.status).toBe(200);
      expect(body.role).toBe("server");
      expect(body.checks.map((check) => check.id)).toEqual(["vault.read-write", "dashboard.status"]);
      expect(calls).toEqual([{ includeSearch: false, role: "server" }]);
    } finally {
      if (previous === undefined) delete process.env["MEMORY_ROLE"];
      else process.env["MEMORY_ROLE"] = previous;
      await server.close();
    }
  });

  it("GET /api/health?role=operator overrides the detected role", async () => {
    const previous = process.env["MEMORY_ROLE"];
    process.env["MEMORY_ROLE"] = "server";
    const operatorReport = verifyReport("pass", "operator", ["vault.read-write", "client.codex.config"]);
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      verifyRunner: async (opts) => opts.role === "operator" ? operatorReport : verifyReport("pass", "server"),
    });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/health?role=operator`);
      const body = await response.json() as VerifyResult;

      expect(response.status).toBe(200);
      expect(body.role).toBe("operator");
      expect(body.checks.map((check) => check.id)).toEqual(["vault.read-write", "client.codex.config"]);
    } finally {
      if (previous === undefined) delete process.env["MEMORY_ROLE"];
      else process.env["MEMORY_ROLE"] = previous;
      await server.close();
    }
  });

  it("GET /api/health?role=bogus returns 400", async () => {
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/health?role=bogus`);
      const body = await response.json() as { error?: string };

      expect(response.status).toBe(400);
      expect(body.error).toContain("role");
    } finally {
      await server.close();
    }
  });

  it("GET /api/health caches reports per role", async () => {
    const calls: VerifyRole[] = [];
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      verifyRunner: async (opts) => {
        calls.push(opts.role);
        return verifyReport("pass", opts.role, [`${opts.role}.check`]);
      },
    });

    try {
      const serverResponse = await fetch(`http://${server.host}:${server.port}/api/health?role=server`);
      const operatorResponse = await fetch(`http://${server.host}:${server.port}/api/health?role=operator`);
      const cachedServerResponse = await fetch(`http://${server.host}:${server.port}/api/health?role=server`);
      const serverBody = await serverResponse.json() as VerifyResult;
      const operatorBody = await operatorResponse.json() as VerifyResult;
      const cachedServerBody = await cachedServerResponse.json() as VerifyResult;

      expect(calls).toEqual(["server", "operator"]);
      expect(serverBody.checks[0]?.id).toBe("server.check");
      expect(operatorBody.checks[0]?.id).toBe("operator.check");
      expect(cachedServerBody).toEqual(serverBody);
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
        timings: expect.objectContaining({
          intentClassification: expect.objectContaining({
            label: expect.any(String),
          }),
        }),
        degraded: expect.any(Boolean),
        hyde: expect.any(Object),
        corpusErrorCount: expect.any(Number),
      });
      expect(body.results.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("GET /api/search accepts an explicit intent override", async () => {
    await writeSearchWiki(tmp);
    const server = await createServer({
      vaultRoot: tmp,
      port: 0,
      voyageClient: mockVoyageClient(),
    });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/search?q=foo&intent=procedure`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.timings.intentClassification).toMatchObject({
        label: "procedure",
        method: "explicit",
      });
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
        frontmatter: expect.objectContaining({ title: "Foo", type: "projects" }),
        body: expect.stringContaining("Foo page content."),
        relations: expect.any(Array),
        inbound: expect.any(Array),
      });
      expect(JSON.stringify(body)).not.toMatch(/[A-Z]:[\\/]|\/root\/|\/home\//);
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
        relPath: `raw/2026-05-24/${filename}`,
        source: "claude-code",
        sessionId: "019e4bf7-d7b8-4a57",
        sizeBytes: expect.any(Number),
        mtime: expect.any(String),
        body: expect.stringContaining("Raw body content."),
        frontmatter: expect.objectContaining({ source: "claude-code", tool: "capture" }),
      });
      expect(body.sizeBytes).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(body.mtime))).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/[A-Z]:[\\/]|\/root\/|\/home\//);
    } finally {
      await server.close();
    }
  });

  it("GET /api/wiki excludes wiki dot-directories", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await mkdir(join(tmp, "wiki", ".audit"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "foo.md"),
      page({ type: "projects", title: "Foo", created: "2026-05-21", updated: "2026-05-23" }, "Foo body.\n"),
    );
    await writeFile(
      join(tmp, "wiki", ".audit", "llm-2026-05-29.md"),
      page({ type: "references", title: "Audit Log", created: "2026-05-29", updated: "2026-05-29" }, "Audit body.\n"),
    );
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/wiki`);
      const body = await response.json();
      const text = JSON.stringify(body);
      expect(response.status).toBe(200);
      expect(text).toContain("projects/foo.md");
      expect(text).not.toContain(".audit");
      expect(text).not.toContain("Audit Log");
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

  it("GET /api/graph-health returns a cached graph health report", async () => {
    await mkdir(join(tmp, "wiki", "tools"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "tools", "a.md"),
      page({
        type: "tools",
        title: "A",
        created: "2026-05-23",
        updated: "2026-05-23",
        source: "codex",
        confidence: 0.9,
        relations: { uses: ["b"] },
      }, "A body.\n"),
    );
    await writeFile(
      join(tmp, "wiki", "tools", "b.md"),
      page({
        type: "tools",
        title: "B",
        created: "2026-05-23",
        updated: "2026-05-23",
        source: "codex",
        confidence: 0.8,
        relations: { depends_on: ["a"] },
      }, "B body.\n"),
    );
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const first = await fetch(`http://${server.host}:${server.port}/api/graph-health`);
      const firstBody = await first.json();
      const second = await fetch(`http://${server.host}:${server.port}/api/graph-health`);
      const secondBody = await second.json();

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(firstBody.metrics).toHaveLength(13);
      expect(firstBody.overallStatus).toBe("pass");
      expect(firstBody.metrics.map((metric: { id: string }) => metric.id)).toContain("graph.participation-rate");
      expect(secondBody).toEqual(firstBody);
    } finally {
      await server.close();
    }
  });

  it("GET /api/graph-health returns 503 when graph health fails", async () => {
    await mkdir(join(tmp, "wiki", "tools"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "tools", "missing-metadata.md"),
      page({
        type: "tools",
        title: "Missing metadata",
        created: "2026-05-23",
        updated: "2026-05-23",
      }, "A body.\n"),
    );
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/graph-health`);
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.overallStatus).toBe("fail");
      expect(body.metrics.map((metric: { id: string }) => metric.id)).toContain("graph.confidence-coverage");
      expect(body.metrics.map((metric: { id: string }) => metric.id)).toContain("graph.participation-rate");
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
      expect(body).toMatchObject({
        status: "idle",
        lastRun: null,
        schedule: { scheduled: false, cadence: "daily", nextRunAt: null },
      });
    } finally {
      await server.close();
    }
  });

  it("GET /api/compile/state explains when execute mode is unavailable", async () => {
    const previous = process.env["MEMORY_LLM_DISABLED"];
    process.env["MEMORY_LLM_DISABLED"] = "true";
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/compile/state`);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        execute: {
          available: false,
          reason: "LLM access disabled by MEMORY_LLM_DISABLED=true",
        },
      });
    } finally {
      if (previous === undefined) {
        delete process.env["MEMORY_LLM_DISABLED"];
      } else {
        process.env["MEMORY_LLM_DISABLED"] = previous;
      }
      await server.close();
    }
  });

  it("POST /api/compile/run runs compile and returns 409 while a run is active", async () => {
    let resolveRun: ((value: { rawFilesIncluded: string[]; rawFilesSkipped: { path: string; reason: string }[]; outputPath: string; rawRemaining: number }) => void) | null = null;
    let markStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const compileRunner = vi.fn(() => new Promise<{ rawFilesIncluded: string[]; rawFilesSkipped: { path: string; reason: string }[]; outputPath: string; rawRemaining: number }>((resolve) => {
      markStarted?.();
      resolveRun = resolve;
    }));
    const server = await createServer({ vaultRoot: tmp, port: 0, compileRunner });

    try {
      const first = fetch(`http://${server.host}:${server.port}/api/compile/run`, { method: "POST" });
      await started;
      const conflict = await fetch(`http://${server.host}:${server.port}/api/compile/run`, { method: "POST" });
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({ error: "compile already running" });

      resolveRun?.({
        rawFilesIncluded: ["raw/a.md", "raw/b.md"],
        rawFilesSkipped: [{ path: "raw/old.md", reason: "before since cutoff" }],
        outputPath: "state/scheduled-compile-prompt.md",
        rawRemaining: 0,
      });
      const response = await first;
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        summary: {
          rawIncluded: 2,
          rawSkipped: 1,
          outputPath: "state/scheduled-compile-prompt.md",
        },
      });
      expect(compileRunner).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("POST /api/compile/run forwards execute requests to the compile runner", async () => {
    const compileRunner = vi.fn(async () => ({
      rawFilesIncluded: ["raw/a.md"],
      rawFilesSkipped: [],
      outputPath: "state/scheduled-compile-prompt.md",
      rawRemaining: 0,
      execution: {
        mode: "execute" as const,
        applied: ["wiki/projects/a.md"],
        proposed: ["wiki/compile-proposed/b.md"],
        planned: [],
        rejected: [],
        outcomes: [
          { path: "wiki/projects/a.md", outcome: "created", contentPreserved: true },
          {
            path: "wiki/compile-proposed/b.md",
            outcome: "staged-for-review",
            reason: "low confidence",
            contentPreserved: true,
          },
        ],
        referencesStripped: 3,
        prosePathLeaks: 0,
      },
    }));
    const server = await createServer({ vaultRoot: tmp, port: 0, compileRunner });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/compile/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ execute: true }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        summary: {
          execute: true,
          rawIncluded: 1,
          rawSkipped: 0,
          rawRemaining: 0,
          opsApplied: 1,
          opsStaged: 1,
          opsRejected: 0,
          outcomes: [
            { path: "wiki/projects/a.md", outcome: "created", contentPreserved: true },
            {
              path: "wiki/compile-proposed/b.md",
              outcome: "staged-for-review",
              reason: "low confidence",
              contentPreserved: true,
            },
          ],
          referencesStripped: 3,
          outputPath: "state/scheduled-compile-prompt.md",
        },
      });
      expect(compileRunner).toHaveBeenCalledWith({ execute: true });
    } finally {
      await server.close();
    }
  });

  it("POST /api/compile/run refuses execute mode on a read-only mirror", async () => {
    await rm(join(tmp, ".git"), { recursive: true, force: true });
    const compileRunner = vi.fn(async () => ({
      rawFilesIncluded: [],
      rawFilesSkipped: [],
      outputPath: "state/scheduled-compile-prompt.md",
      rawRemaining: 0,
    }));
    const server = await createServer({ vaultRoot: tmp, port: 0, compileRunner });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/compile/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ execute: true }),
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: READ_ONLY_MIRROR_REASON });
      expect(compileRunner).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("POST /api/compile/run accepts proxy-reconstructed same-origin and rejects genuine cross-origin", async () => {
    const compileRunner = vi.fn(async () => ({
      rawFilesIncluded: ["raw/a.md"],
      rawFilesSkipped: [],
      outputPath: "state/scheduled-compile-prompt.md",
      rawRemaining: 0,
    }));
    const server = await createServer({ vaultRoot: tmp, port: 0, compileRunner });

    try {
      const origin = `http://${server.host}:${server.port}`;
      const allowed = await fetch(`${origin}/api/compile/run`, {
        method: "POST",
        headers: {
          Origin: "https://srv1317946.tail6916d8.ts.net",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "srv1317946.tail6916d8.ts.net",
        },
      });
      expect(allowed.status).toBe(200);

      const blocked = await fetch(`${origin}/api/compile/run`, {
        method: "POST",
        headers: {
          Origin: "https://evil.example.com",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "srv1317946.tail6916d8.ts.net",
        },
      });
      expect(blocked.status).toBe(403);
      expect(compileRunner).toHaveBeenCalledOnce();
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
      expect(Array.isArray(body.pruneCandidates)).toBe(true);
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

  it("GET /api/config redacts secret-named fields outside voyage.api_key", async () => {
    await writeFile(
      join(tmp, "config.yaml"),
      [
        "llm:",
        '  provider: "openrouter"',
        '  model: "openai/gpt-4o-mini"',
        "  max_tokens: 4096",
        '  api_key: "sk-FAKE12345"',
        "  options:",
        '    access_token: "nested-secret"',
        "voyage:",
        "  dim: 2048",
        "",
      ].join("\n"),
    );
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/config`);
      const text = await response.text();
      const body = JSON.parse(text);
      expect(response.status).toBe(200);
      expect(text).not.toContain("sk-FAKE12345");
      expect(text).not.toContain("nested-secret");
      expect(body).toEqual({
        llm: {
          provider: "openrouter",
          model: "openai/gpt-4o-mini",
          max_tokens: 4096,
          api_key: "[REDACTED]",
          options: {
            access_token: "[REDACTED]",
          },
        },
        voyage: { dim: 2048 },
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

  it("PATCH /api/config accepts proxy-reconstructed same-origin and rejects genuine cross-origin", async () => {
    await writeFile(join(tmp, "config.yaml"), ["embedder:", "  provider: voyage", ""].join("\n"));
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const origin = `http://${server.host}:${server.port}`;
      const allowed = await fetch(`${origin}/api/config`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://srv1317946.tail6916d8.ts.net",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "srv1317946.tail6916d8.ts.net",
        },
        body: JSON.stringify({ embedder: { provider: "openai" } }),
      });
      expect(allowed.status).toBe(200);

      const blocked = await fetch(`${origin}/api/config`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example.com",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "srv1317946.tail6916d8.ts.net",
        },
        body: JSON.stringify({ embedder: { provider: "voyage" } }),
      });
      expect(blocked.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("GET /api/proposed endpoints list drafts and summary counts", async () => {
    await writeProposedDrafts(tmp);
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const threadsResponse = await fetch(`http://${server.host}:${server.port}/api/proposed/threads`);
      const proceduresResponse = await fetch(`http://${server.host}:${server.port}/api/proposed/procedures`);
      const summaryResponse = await fetch(`http://${server.host}:${server.port}/api/proposed/summary`);

      expect(threadsResponse.status).toBe(200);
      await expect(threadsResponse.json()).resolves.toMatchObject([
        {
          kind: "thread",
          slug: "memory-thread",
          title: "Memory Thread",
          observationCount: 5,
          distinctSessions: 2,
          confidence: { level: "high", reasons: ["all signals clean"] },
          prosePreview: "Thread summary paragraph.",
        },
      ]);
      expect(proceduresResponse.status).toBe(200);
      await expect(proceduresResponse.json()).resolves.toMatchObject([
        {
          kind: "procedure",
          slug: "review-procedure",
          title: "Review Procedure",
          observationCount: 3,
          distinctSessions: 1,
          confidence: { level: "low" },
          steps: 2,
        },
      ]);
      await expect(summaryResponse.json()).resolves.toMatchObject({
        total: 2,
        threads: { total: 1, high: 1, low: 0 },
        procedures: { total: 1, high: 0, low: 1 },
      });
    } finally {
      await server.close();
    }
  });

  it("POST /api/proposed/promote and reject are same-origin gated", async () => {
    await writeProposedDrafts(tmp);
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const blocked = await fetch(`http://${server.host}:${server.port}/api/proposed/promote`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example.com",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "srv1317946.tail6916d8.ts.net",
        },
        body: JSON.stringify({ kind: "thread", slug: "memory-thread" }),
      });
      expect(blocked.status).toBe(403);

      const promoted = await fetch(`http://${server.host}:${server.port}/api/proposed/promote`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://srv1317946.tail6916d8.ts.net",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "srv1317946.tail6916d8.ts.net",
        },
        body: JSON.stringify({ kind: "thread", slug: "memory-thread" }),
      });
      expect(promoted.status).toBe(200);
      await expect(promoted.json()).resolves.toEqual({
        ok: true,
        promotedPath: "wiki/threads/memory-thread.md",
      });

      const rejected = await fetch(`http://${server.host}:${server.port}/api/proposed/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "procedure", slug: "review-procedure" }),
      });
      expect(rejected.status).toBe(200);
      await expect(rejected.json()).resolves.toEqual({
        ok: true,
        rejectedPath: "wiki/procedures-proposed/review-procedure.md",
      });
    } finally {
      await server.close();
    }
  });

  it("POST /api/proposed promote and reject refuse writes on a read-only mirror", async () => {
    await rm(join(tmp, ".git"), { recursive: true, force: true });
    await writeProposedDrafts(tmp);
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const promote = await fetch(`http://${server.host}:${server.port}/api/proposed/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "thread", slug: "memory-thread" }),
      });
      const reject = await fetch(`http://${server.host}:${server.port}/api/proposed/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "procedure", slug: "review-procedure" }),
      });

      expect(promote.status).toBe(403);
      expect(reject.status).toBe(403);
      await expect(promote.json()).resolves.toEqual({ error: READ_ONLY_MIRROR_REASON });
      await expect(reject.json()).resolves.toEqual({ error: READ_ONLY_MIRROR_REASON });
    } finally {
      await server.close();
    }
  });

  it("POST /api/proposed actions validate body and report missing drafts", async () => {
    const server = await createServer({ vaultRoot: tmp, port: 0 });

    try {
      const malformed = await fetch(`http://${server.host}:${server.port}/api/proposed/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "bad", slug: "x" }),
      });
      expect(malformed.status).toBe(400);

      const missing = await fetch(`http://${server.host}:${server.port}/api/proposed/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "thread", slug: "missing" }),
      });
      expect(missing.status).toBe(404);
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
      await expect(response.json()).resolves.toEqual({
        ...status,
        capabilities: { writable: true },
      });
    } finally {
      await server.close();
    }
  });
});

async function writeProposedDrafts(root: string): Promise<void> {
  await mkdir(join(root, "wiki", "threads-proposed"), { recursive: true });
  await mkdir(join(root, "wiki", "procedures-proposed"), { recursive: true });
  await writeFile(
    join(root, "wiki", "threads-proposed", "memory-thread.md"),
    [
      "---",
      'type: "threads"',
      'title: "Memory Thread"',
      'created: "2026-05-28"',
      'updated: "2026-05-28"',
      'lifecycle: "proposed"',
      "time_range:",
      '  start: "2026-05-24"',
      '  end: "2026-05-28"',
      "relations:",
      "  mentions:",
      '    - "raw/2026-05-24/codex-a.md"',
      '    - "raw/2026-05-25/codex-b.md"',
      "proposal_confidence:",
      '  level: "high"',
      "  reasons:",
      '    - "all signals clean"',
      "  observation_count: 5",
      "  distinct_sessions: 2",
      "---",
      "",
      "# Memory Thread",
      "",
      "Thread summary paragraph.",
      "",
      "## Key decisions",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "wiki", "procedures-proposed", "review-procedure.md"),
    [
      "---",
      'type: "procedures"',
      'title: "Review Procedure"',
      'created: "2026-05-28"',
      'updated: "2026-05-28"',
      'lifecycle: "proposed"',
      "relations:",
      "  derived_from:",
      '    - "raw/2026-05-24/codex-a.md"',
      "proposal_confidence:",
      '  level: "low"',
      "  reasons:",
      '    - "observationCount=3 below threshold 5"',
      "  observation_count: 3",
      "  distinct_sessions: 1",
      "---",
      "",
      "# Review Procedure",
      "",
      "Procedure summary paragraph.",
      "",
      "## Steps",
      "",
      "1. Run the review.",
      "",
      "```bash",
      "memory search review",
      "```",
      "2. Record the result.",
      "",
    ].join("\n"),
  );
}

function verifyReport(
  overallStatus: VerifyResult["overallStatus"],
  role: VerifyRole = "operator",
  ids: string[] = ["vault.read-write"],
): VerifyResult {
  return {
    startedAt: "2026-05-26T03:30:00.000Z",
    finishedAt: "2026-05-26T03:30:01.000Z",
    role,
    overallStatus,
    checks: ids.map((id) => ({
        id,
        label: id,
        status: overallStatus === "fail" ? "fail" : "pass",
        durationMs: 1,
        suggestedFix: overallStatus === "fail" ? "run `memory init`" : undefined,
      })),
    passed: overallStatus === "fail" ? 0 : 1,
    failed: overallStatus === "fail" ? 1 : 0,
    warnings: overallStatus === "warn" ? 1 : 0,
    exitCode: overallStatus === "fail" ? 1 : 0,
  };
}
