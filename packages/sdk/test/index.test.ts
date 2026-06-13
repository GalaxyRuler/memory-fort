import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryFortClient } from "../src/index.js";

const BASE = "http://127.0.0.1:4410/memory";

describe("MemoryFortClient", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("search sends GET /api/search with encoded query", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ results: [{ path: "wiki/tools/voyage.md", score: 0.9 }] }),
    );
    const client = new MemoryFortClient({ baseUrl: BASE });
    const results = await client.search("voyage embeddings");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/search?q=voyage"),
      expect.any(Object),
    );
    expect(results[0]?.path).toBe("wiki/tools/voyage.md");
  });

  it("search passes agentId, userId, asOf, identityMode as query params", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ results: [] }));
    const client = new MemoryFortClient({ baseUrl: BASE });
    await client.search("test", {
      agentId: "codex",
      userId: "alice",
      asOf: "2026-01-01",
      identityMode: "strict",
    });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("agent_id=codex");
    expect(url).toContain("user_id=alice");
    expect(url).toContain("as_of=2026-01-01");
    expect(url).toContain("identity_mode=strict");
  });

  it("add sends POST /api/observations with text", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ ok: true }));
    const client = new MemoryFortClient({ baseUrl: BASE });
    await client.add("Switched from ESLint to Biome");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/observations"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("log is an alias for add", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ ok: true }));
    const client = new MemoryFortClient({ baseUrl: BASE });
    await client.log("test observation");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/observations"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("listPages returns page metadata array", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ pages: [{ path: "wiki/tools/voyage.md", title: "Voyage" }] }),
    );
    const client = new MemoryFortClient({ baseUrl: BASE });
    const pages = await client.listPages();
    expect(Array.isArray(pages)).toBe(true);
    expect(pages[0]?.title).toBe("Voyage");
  });

  it("listPages passes type filter", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ pages: [] }));
    const client = new MemoryFortClient({ baseUrl: BASE });
    await client.listPages({ type: "tools" });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("/api/pages?type=tools");
  });

  it("throws MemoryFortError on non-200 response", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ error: "vault not found" }, 404));
    const client = new MemoryFortClient({ baseUrl: BASE });
    await expect(client.search("test")).rejects.toThrow("vault not found");
  });

  it("sends authorization header when apiKey provided", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ results: [] }));
    const client = new MemoryFortClient({ baseUrl: BASE, apiKey: "secret" });
    await client.search("test");
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
  });
});
