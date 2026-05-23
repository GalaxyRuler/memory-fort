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
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
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
});
