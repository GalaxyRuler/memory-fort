import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logObservation, readPage, listPages, createServer, embeddingProviderPreflight } from "../../src/mcp/server.js";
import { parseFrontmatter } from "../../src/storage/frontmatter.js";

describe("logObservation", () => {
  let tmp: string;
  let origEnv: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "mcp-log-"));
    origEnv = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
  });

  afterEach(async () => {
    if (origEnv === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origEnv;
    await rm(tmp, { recursive: true, force: true });
  });

  it("appends an observation to today's raw file", async () => {
    const result = await logObservation({ text: "remember this", tags: ["a", "b"] });
    expect(result.content[0]!.text).toMatch(/Logged observation/);
    const date = new Date().toISOString().slice(0, 10);
    const rawDir = join(tmp, "raw", date);
    expect(existsSync(rawDir)).toBe(true);
    const files = await readdir(rawDir);
    expect(files.length).toBe(1);
    const content = await readFile(join(rawDir, files[0]!), "utf-8");
    expect(content).toContain("remember this");
    expect(content).toContain("tags: a, b");
    expect(content).toContain("observed_at:");
  });

  it("uses source field to set tool name in filename", async () => {
    await logObservation({ text: "x", source: "manual" });
    const date = new Date().toISOString().slice(0, 10);
    const rawDir = join(tmp, "raw", date);
    const files = await readdir(rawDir);
    expect(files[0]).toMatch(/^manual-/);
  });

  it("commits the raw observation file after append without blocking the tool result", async () => {
    const now = new Date(Date.UTC(2026, 4, 28, 12, 34, 56));
    const commitVaultChange = vi.fn(async () => ({ kind: "committed" as const, commitSha: "abc1234" }));

    const result = await logObservation(
      { text: "commit this", source: "manual", confidence: 0.9 },
      {
        now: () => now,
        sessionId: () => "session-1",
        commitVaultChange,
      },
    );

    expect(result.content[0]!.text).toContain("Logged observation");
    expect(commitVaultChange).toHaveBeenCalledWith({
      paths: ["raw/2026-05-28/manual-session-1.md"],
      message: "chore: log manual observation",
      memoryRoot: tmp,
    });
  });

  it("still logs the observation when commit-on-write fails", async () => {
    const now = new Date(Date.UTC(2026, 4, 28, 12, 34, 56));
    const commitVaultChange = vi.fn(async () => ({ kind: "failed" as const, error: "git unavailable" }));

    const result = await logObservation(
      { text: "best effort commit", source: "manual" },
      {
        now: () => now,
        sessionId: () => "session-2",
        commitVaultChange,
      },
    );

    expect(result.content[0]!.text).toContain("Logged observation");
    const content = await readFile(join(tmp, "raw", "2026-05-28", "manual-session-2.md"), "utf-8");
    expect(content).toContain("best effort commit");
  });
});

describe("readPage", () => {
  let tmp: string;
  let origEnv: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "mcp-read-"));
    origEnv = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "agentmemory.md"),
      `---\ntype: projects\ntitle: agentmemory\ncreated: "2026-05-20"\nupdated: "2026-05-21"\ntags: [windows, stability]\n---\n\nThe summary.\n\nBody content.\n`,
    );
    await mkdir(join(tmp, "wiki", ".audit"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", ".audit", "llm-2026-05-29.md"),
      `---\ntype: references\ntitle: Audit Log\nupdated: "2026-05-29"\n---\n\nOperational audit details.\n`,
    );
  });

  afterEach(async () => {
    if (origEnv === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origEnv;
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads a wiki page and returns formatted content", async () => {
    const result = await readPage({ path: "projects/agentmemory.md" });
    const text = result.content[0]!.text;
    expect(text).toContain("# agentmemory");
    expect(text).toContain("**Type:** projects");
    expect(text).toContain("Body content");
    expect(text).toContain("windows, stability");
  });

  it("bumps last_accessed without changing version when read through the MCP server", async () => {
    await writeFile(
      join(tmp, "wiki", "projects", "agentmemory.md"),
      `---\ntype: projects\ntitle: agentmemory\ncreated: "2026-05-20"\nupdated: "2026-05-21"\nversion: 3\nlast_accessed: "2026-05-30"\n---\n\nThe summary.\n`,
    );
    const { client, close } = await connectMcp(undefined, { now: () => new Date("2026-06-02T00:00:00.000Z") });
    try {
      await client.callTool({ name: "read_page", arguments: { path: "projects/agentmemory.md" } });
    } finally {
      await close();
    }

    const parsed = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "agentmemory.md"), "utf-8"));
    expect(parsed.frontmatter.last_accessed).toBe("2026-06-02");
    expect(parsed.frontmatter.version).toBe(3);
    expect(parsed.frontmatter.supersedes).toBeUndefined();
  });

  it("returns isError on missing page", async () => {
    const result = await readPage({ path: "projects/missing.md" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });

  it("rejects path traversal attempts", async () => {
    const result = await readPage({ path: "../../../etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Invalid path");
  });

  it("rejects absolute Windows paths", async () => {
    const result = await readPage({ path: "C:/Windows/system32/secret.md" });
    expect(result.isError).toBe(true);
  });

  it("rejects wiki dot-directory pages", async () => {
    const result = await readPage({ path: ".audit/llm-2026-05-29.md" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Invalid path");
  });
});

describe("listPages", () => {
  let tmp: string;
  let origEnv: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "mcp-list-"));
    origEnv = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await mkdir(join(tmp, "wiki", "lessons"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "a.md"),
      `---\ntype: projects\ntitle: A\ncreated: "2026-05-20"\nupdated: "2026-05-20"\ntags: [windows]\n---\nx\n`,
    );
    await writeFile(
      join(tmp, "wiki", "projects", "b.md"),
      `---\ntype: projects\ntitle: B\ncreated: "2026-05-21"\nupdated: "2026-05-21"\nstatus: archived\n---\ny\n`,
    );
    await writeFile(
      join(tmp, "wiki", "lessons", "c.md"),
      `---\ntype: lessons\ntitle: C\ncreated: "2026-05-20"\nupdated: "2026-05-20"\ntags: [stability, windows]\n---\nz\n`,
    );
    await mkdir(join(tmp, "wiki", ".audit"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", ".audit", "llm-2026-05-29.md"),
      `---\ntype: references\ntitle: Audit Log\ncreated: "2026-05-29"\nupdated: "2026-05-29"\n---\naudit\n`,
    );
  });

  afterEach(async () => {
    if (origEnv === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origEnv;
    await rm(tmp, { recursive: true, force: true });
  });

  it("lists all pages when no filters set", async () => {
    const result = await listPages({});
    const text = result.content[0]!.text;
    expect(text).toContain("Found 3 pages");
    expect(text).toContain("projects/a.md");
    expect(text).toContain("projects/b.md");
    expect(text).toContain("lessons/c.md");
    expect(text).not.toContain(".audit");
    expect(text).not.toContain("Audit Log");
  });

  it("filters by type", async () => {
    const result = await listPages({ type: "lessons" });
    const text = result.content[0]!.text;
    expect(text).toContain("Found 1 page");
    expect(text).toContain("lessons/c.md");
    expect(text).not.toContain("projects/");
  });

  it("filters by tag", async () => {
    const result = await listPages({ tag: "windows" });
    const text = result.content[0]!.text;
    expect(text).toContain("Found 2 pages");
    expect(text).toContain("projects/a.md");
    expect(text).toContain("lessons/c.md");
  });

  it("filters by status archived", async () => {
    const result = await listPages({ status: "archived" });
    const text = result.content[0]!.text;
    expect(text).toContain("Found 1 page");
    expect(text).toContain("projects/b.md");
  });

  it("returns no-match message when filters match nothing", async () => {
    const result = await listPages({ tag: "nonexistent" });
    expect(result.content[0]!.text).toMatch(/No pages match/);
  });
});

describe("memory.search MCP tool", () => {
  it("registers search alongside the existing tools", async () => {
    const { client, close } = await connectMcp();
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["list_pages", "log_observation", "read_page", "search"]);
    } finally {
      await close();
    }
  });

  it("calls the API and returns formatted results", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mcp-search-access-"));
    const origEnv = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
    await mkdir(join(tmp, "wiki", "tools"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "tools", "voyageai.md"),
      `---\ntype: tools\ntitle: voyageai\ncreated: "2026-05-20"\nupdated: "2026-05-21"\nversion: 2\nlast_accessed: "2026-05-30"\n---\n\nVoyageAI is used for embeddings.\n`,
    );
    const fetchFn = vi.fn(async () => jsonResponse(searchFixture())) as unknown as typeof fetch;
    const { client, close } = await connectMcp(fetchFn, { now: () => new Date("2026-06-02T00:00:00.000Z") });
    try {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "voyage", scope: "wiki", k: 2 },
      });
      const text = textFromToolResult(result);
      expect(text).toContain("2 results for \"voyage\"");
      expect(text).toContain("wiki/tools/voyageai.md");
      expect(text).toContain("wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md");
      const parsed = JSON.parse(extractJsonFence(text));
      expect(parsed.result_count).toBe(2);
      expect(parsed.results[0].path).toBe("wiki/tools/voyageai.md");
      expect(parsed.results[0].provenance).toEqual({
        path: parsed.results[0].path,
        kind: parsed.results[0].kind,
        dominantSource: parsed.results[0].source,
        signals: expect.arrayContaining([
          expect.objectContaining({
            source: expect.any(String),
            rank: expect.any(Number),
          }),
        ]),
      });
      expect(parsed.results.some((item: { path: string }) => item.path.startsWith("wiki/.audit/"))).toBe(false);
      const parsedPage = parseFrontmatter(await readFile(join(tmp, "wiki", "tools", "voyageai.md"), "utf-8"));
      expect(parsedPage.frontmatter.last_accessed).toBe("2026-06-02");
      expect(parsedPage.frontmatter.version).toBe(2);
    } finally {
      await close();
      if (origEnv === undefined) delete process.env["MEMORY_ROOT"];
      else process.env["MEMORY_ROOT"] = origEnv;
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("ignores forged nested provenance signals and infers legacy raw and crystal result kinds", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        query: "legacy",
        results: [
          {
            path: "raw/2026-06-01/session.md",
            title: "Raw session",
            snippet: "Raw capture",
            score: 0.7,
            source: "bm25",
            sources: [
              { source: "bm25", rank: 2 },
              { source: "bad-rank", rank: "not-a-number" },
            ],
            provenance: {
              path: "wiki/forged.md",
              kind: "wiki",
              dominantSource: "forged",
              signals: [
                { source: "graph-spread", rank: 4 },
                { source: 42, rank: 5 },
              ],
              auditTrail: ["should not leak"],
            },
          },
          {
            path: "crystals/retrieval.md",
            title: "Retrieval crystal",
            snippet: "Crystal summary",
            score: 0.6,
            source: "vector",
            sources: [
              { source: "vector", rank: 1 },
              { source: "missing-rank" },
            ],
          },
        ],
        warnings: [],
        timings: { totalMs: 12, rerankMs: 0 },
        degraded: false,
      }),
    ) as unknown as typeof fetch;
    const { client, close } = await connectMcp(fetchFn);
    try {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "legacy" },
      });
      const parsed = JSON.parse(extractJsonFence(textFromToolResult(result)));

      expect(parsed.results[0]).toMatchObject({
        path: "raw/2026-06-01/session.md",
        kind: "raw",
        sources: [{ source: "bm25", rank: 2 }],
        provenance: {
          path: "raw/2026-06-01/session.md",
          kind: "raw",
          dominantSource: "bm25",
          signals: [{ source: "bm25", rank: 2 }],
        },
      });
      expect(parsed.results[0].provenance.signals).not.toBe(parsed.results[0].sources);
      expect(parsed.results[0].provenance).not.toHaveProperty("auditTrail");
      expect(parsed.results[1]).toMatchObject({
        path: "crystals/retrieval.md",
        kind: "crystal",
        sources: [{ source: "vector", rank: 1 }],
        provenance: {
          path: "crystals/retrieval.md",
          kind: "crystal",
          dominantSource: "vector",
          signals: [{ source: "vector", rank: 1 }],
        },
      });
    } finally {
      await close();
    }
  });

  it("returns a clear tool error when search results are not an array", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        query: "malformed",
        results: { path: "wiki/not-an-array.md" },
      }),
    ) as unknown as typeof fetch;
    const { client, close } = await connectMcp(fetchFn);
    try {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "malformed" },
      });

      expect(result.isError).toBe(true);
      expect(textFromToolResult(result)).toContain("Search backend returned invalid results");
    } finally {
      await close();
    }
  });

  it("returns a clear tool error when the search body is null", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(null)) as unknown as typeof fetch;
    const { client, close } = await connectMcp(fetchFn);
    try {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "null body" },
      });

      expect(result.isError).toBe(true);
      expect(textFromToolResult(result)).toContain("Search backend returned invalid results");
    } finally {
      await close();
    }
  });

  it("skips search result entries without a string path", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        query: "invalid path",
        results: [
          {
            path: 42,
            title: "Forged numeric path",
            snippet: "This result should be skipped.",
            score: 0.9,
            source: "bm25",
            sources: [{ source: "bm25", rank: 1 }],
          },
          {
            path: "wiki/valid.md",
            title: "Valid",
            snippet: "This result remains.",
            score: 0.8,
            source: "vector",
            sources: [{ source: "vector", rank: 1 }],
            kind: "wiki",
          },
        ],
        warnings: [],
        timings: { totalMs: 1, rerankMs: 0 },
        degraded: false,
      }),
    ) as unknown as typeof fetch;
    const { client, close } = await connectMcp(fetchFn);
    try {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "invalid path" },
      });
      const parsed = JSON.parse(extractJsonFence(textFromToolResult(result)));

      expect(parsed.result_count).toBe(1);
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].path).toBe("wiki/valid.md");
    } finally {
      await close();
    }
  });

  it("sanitizes non-string source fields and non-finite scores", async () => {
    const fetchFn = vi.fn(async () =>
      ({
        ok: true,
        json: async () => ({
          query: "unsafe fields",
          results: [
            {
              path: "wiki/unsafe.md",
              title: 99,
              snippet: { text: "not a string" },
              score: Number.POSITIVE_INFINITY,
              source: { forged: true },
              sources: [{ source: "bm25", rank: 1 }],
              provenance: {
                dominantSource: "forged",
                signals: [{ source: "graph-spread", rank: 2 }],
              },
              kind: "wiki",
            },
          ],
          warnings: [],
          timings: { totalMs: 1, rerankMs: 0 },
          degraded: false,
        }),
      }) as Response,
    ) as unknown as typeof fetch;
    const { client, close } = await connectMcp(fetchFn);
    try {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "unsafe fields" },
      });
      const parsed = JSON.parse(extractJsonFence(textFromToolResult(result)));

      expect(parsed.results[0]).toMatchObject({
        path: "wiki/unsafe.md",
        title: "wiki/unsafe.md",
        snippet: "",
        score: 0,
        source: "unknown",
        provenance: {
          dominantSource: "unknown",
          signals: [{ source: "bm25", rank: 1 }],
        },
      });
    } finally {
      await close();
    }
  });

  it("returns a clear tool error when the search dashboard is unreachable", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { client, close } = await connectMcp(fetchFn);
    try {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "voyage" },
      });
      expect(result.isError).toBe(true);
      const text = textFromToolResult(result);
      expect(text).toContain("Search dashboard offline");
      expect(text).toContain("dashboard URL");
      expect(text).toContain("read_page");
      expect(text).toContain("list_pages");
    } finally {
      await close();
    }
  });

  it("passes hyde_expansion through to the search API URL", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (input) => {
      urls.push(String(input));
      return jsonResponse(searchFixture());
    }) as unknown as typeof fetch;
    const { client, close } = await connectMcp(fetchFn);
    try {
      await client.callTool({
        name: "search",
        arguments: {
          query: "voyage",
          hyde_expansion: "Voyage AI is an embedding provider...",
        },
      });
      expect(urls[0]).toContain(
        "hydeExpansion=Voyage+AI+is+an+embedding+provider",
      );
      expect(urls[0]).toContain("noRerank=true");
    } finally {
      await close();
    }
  });

  it("defaults MCP search to noRerank for latency and lets callers opt into rerank", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (input) => {
      urls.push(String(input));
      return jsonResponse(searchFixture());
    }) as unknown as typeof fetch;
    const { client, close } = await connectMcp(fetchFn);
    try {
      await client.callTool({
        name: "search",
        arguments: { query: "operator preferences" },
      });
      await client.callTool({
        name: "search",
        arguments: { query: "operator preferences", no_rerank: false },
      });
      expect(urls[0]).toContain("noRerank=true");
      expect(urls[1]).toContain("noRerank=false");
    } finally {
      await close();
    }
  });
});

describe("embeddingProviderPreflight", () => {
  it("warns when the active embedding provider key is missing", async () => {
    const warnings = await embeddingProviderPreflight({
      configLoader: async () => ({ embedder: { provider: "voyage", model: "voyage-4-large" } }),
      env: {},
    });

    expect(warnings[0]).toContain("VOYAGE_API_KEY");
    expect(warnings[0]).toContain("missing");
  });
});

async function connectMcp(fetchFn?: typeof fetch, deps: Parameters<typeof createServer>[0] = {}): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createServer({ ...deps, ...(fetchFn ? { fetchFn } : {}) });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function searchFixture() {
  return {
    query: "voyage",
    results: [
      {
        path: "wiki/.audit/llm-2026-05-29.md",
        title: "Audit Log",
        snippet: "Operational audit details should not reach MCP search.",
        score: 0.99,
        source: "bm25",
        sources: [{ source: "bm25", rank: 0 }],
        kind: "wiki",
      },
      {
        path: "wiki/tools/voyageai.md",
        title: "voyageai npm SDK",
        snippet: "Official TypeScript SDK for Voyage AI embedding and rerank APIs.",
        score: 0.91,
        source: "rerank",
        sources: [{ source: "bm25", rank: 1 }],
        kind: "wiki",
      },
      {
        path: "wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md",
        title: "Voyage AI for embeddings and reranking",
        snippet: "Decision record for using Voyage AI in Phase 3 retrieval.",
        score: 0.88,
        source: "vector",
        sources: [{ source: "vector", rank: 1 }],
        kind: "wiki",
      },
    ],
    warnings: [],
    timings: { totalMs: 123, rerankMs: 45 },
    degraded: false,
    hyde: { used: false, reason: "not-triggered" },
    corpusErrorCount: 0,
  };
}

function textFromToolResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = "content" in result ? result.content[0] : undefined;
  if (!first || first.type !== "text") {
    throw new Error("expected text tool result");
  }
  return first.text;
}

function extractJsonFence(text: string): string {
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!match) throw new Error("missing json fence");
  return match[1]!;
}
