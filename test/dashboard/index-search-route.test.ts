import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/retrieval/corpus.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/retrieval/corpus.js")>(
    "../../src/retrieval/corpus.js",
  );
  return {
    ...actual,
    loadSearchCorpus: vi.fn(async () => {
      throw new Error("legacy loadSearchCorpus should not run in index mode");
    }),
  };
});

import { createServer, type RunningServer } from "../../src/dashboard/server.js";
import { startIndexWriter } from "../../src/dashboard/index-writer.js";
import { deleteIndexDbFiles, openIndexDb, type IndexDb } from "../../src/index/db.js";
import { beginIndexInvalidation } from "../../src/index/generation.js";
import {
  createEmbeddingProfileFingerprint,
  type EmbeddingProfileFingerprint,
} from "../../src/index/embed.js";
import { reconcileIndex } from "../../src/index/reconcile.js";
import type { SearchExecutor } from "../../src/index/vector-search.js";
import { loadSearchCorpus } from "../../src/retrieval/corpus.js";

class FakeParentPort extends EventEmitter {
  readonly posted: unknown[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
}

describe("dashboard index search route", () => {
  let tempDir: string | null = null;
  let server: RunningServer | null = null;
  const openDbs: IndexDb[] = [];

  afterEach(async () => {
    await server?.close();
    server = null;
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
    vi.clearAllMocks();
  });

  it("reports the typed default index search capabilities", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();

    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_DB_PATH: indexDbPath },
      voyageClient: null,
    });

    const response = await fetch(
      `http://${server.host}:${server.port}/api/search/capabilities`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      searchBackend: "index-lexical",
      supportedParams: [
        "q",
        "limit",
        "k",
        "cursor",
        "scope",
        "includeArchived",
        "as_of",
        "agent_id",
        "user_id",
        "identity_mode",
      ],
      unsupportedParams: ["minScore", "noRerank", "noHyde", "hydeExpansion", "intent"],
      scopes: ["all", "wiki", "raw", "crystals"],
    });
  });

  it("reports the typed legacy search capabilities", async () => {
    const { vaultRoot } = await createVault();
    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_SEARCH: "0" },
      voyageClient: null,
    });

    const response = await fetch(
      `http://${server.host}:${server.port}/api/search/capabilities`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      searchBackend: "legacy",
      supportedParams: [
        "q",
        "k",
        "scope",
        "minScore",
        "noRerank",
        "noHyde",
        "hydeExpansion",
        "intent",
        "as_of",
        "agent_id",
        "user_id",
        "identity_mode",
      ],
      unsupportedParams: ["includeArchived"],
      scopes: ["all", "wiki", "raw", "crystals"],
    });
  });
  it("rejects invalid shared search filters with a stable invalid_params body", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();
    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_DB_PATH: indexDbPath },
      voyageClient: null,
    });

    for (const [query, invalidParam] of [
      ["scope=bogus", "scope"],
      ["identity_mode=bogus", "identity_mode"],
      ["includeArchived=1", "includeArchived"],
    ] as const) {
      const response = await fetch(
        `http://${server.host}:${server.port}/api/search?q=needle&${query}`,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_params",
        invalid_params: [invalidParam],
      });
    }
  });


  it("rejects controls unsupported by the legacy backend with the same 422 shape", async () => {
    const { vaultRoot } = await createVault();
    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_SEARCH: "0" },
      voyageClient: null,
    });

    for (const value of ["", "1", "true"]) {
      const response = await fetch(
        `http://${server.host}:${server.port}/api/search?q=needle&includeArchived=${value}`,
      );

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        error: "unsupported_params",
        unsupported_params: ["includeArchived"],
      });
    }
  });

  it("uses lexical index search by default without loading the legacy corpus", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const response = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.query).toBe("needle");
    expect(body.searchBackend).toBe("index-lexical");
    expect(body.ignoredParams).toEqual([]);
    expect(body.results).toEqual([
      expect.objectContaining({
        path: "wiki/indexed.md",
        source: "index",
        snippet: expect.stringContaining("needle"),
      }),
    ]);
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("quiesces a cached dashboard reader when shared index invalidation begins", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();
    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_DB_PATH: indexDbPath },
      voyageClient: null,
    });

    const first = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    expect((await first.json()).results).toHaveLength(1);

    await beginIndexInvalidation(vaultRoot);
    const quiesced = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    expect((await quiesced.json()).results).toEqual([]);
    deleteIndexDbFiles(indexDbPath);

    const second = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const body = await second.json();
    expect(body.results).toEqual([]);
    expect(body.index.currentState).toBe("building");
    expect(body.index.lastError).toContain("invalidation");
  });

  it("returns factual indexed provenance instead of receipt defaults", async () => {
    const content = [
      "---",
      "title: Provenance",
      "type: projects",
      "confidence:",
      "  extraction: 0.73",
      "  validation: user",
      "source_facts:",
      "  - fact-a",
      "  - fact-b",
      "relations:",
      "  derived_from:",
      "    - raw/2026-07-23/a.md",
      "---",
      "",
      "# Exact source",
      "",
      "provenanceneedle lives in this exact UTF-8 range.",
    ].join("\n");
    const { vaultRoot, indexDbPath } = await createIndexedVaultWithPages([
      ["wiki/projects/provenance.md", content],
    ]);
    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_DB_PATH: indexDbPath },
      voyageClient: null,
    });

    const response = await fetch(
      `http://${server.host}:${server.port}/api/search?q=provenanceneedle`,
    );
    const body = await response.json();
    const result = body.results[0];
    const receipt = result.provenance;
    const source = Buffer.from(content, "utf8");
    const exactBytes = source.subarray(receipt.byteStart, receipt.byteEnd);

    expect(response.status).toBe(200);
    expect(receipt).toMatchObject({
      path: "wiki/projects/provenance.md",
      kind: "wiki",
      confidence: 0.73,
      confidenceMetadata: { extraction: 0.73, validation: "user" },
      validation: "user",
      sourceFactCount: 2,
      derivedFromCount: 1,
      chunkId: expect.any(String),
      chunkOrdinal: expect.any(Number),
      byteStart: expect.any(Number),
      byteEnd: expect.any(Number),
      sourceContentHash: createHash("sha256").update(source).digest("hex"),
      chunkTextHash: createHash("sha256").update(result.snippet).digest("hex"),
      indexGeneration: 1,
      indexedAt: expect.any(String),
      appliedScope: "all",
      appliedFilters: {
        includeArchived: false,
        asOf: null,
        agentId: null,
        userId: null,
        identityMode: "inclusive",
      },
      backend: "index-lexical",
      rankingProfile: "bm25-metadata-v1",
    });
    expect(exactBytes.toString("utf8")).toBe(result.snippet);
  });

  it("rejects a fabricated provenance range through the response contract", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVaultWithPages([
      ["wiki/projects/receipt.md", "# Receipt\n\nreceiptneedle exact bytes"],
    ]);
    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_DB_PATH: indexDbPath },
      voyageClient: null,
    });
    const search = await fetch(
      `http://${server.host}:${server.port}/api/search?q=receiptneedle`,
    );
    const result = (await search.json()).results[0];

    const validResponse = await fetch(
      `http://${server.host}:${server.port}/api/search/provenance/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result.provenance),
      },
    );
    await expect(validResponse.json()).resolves.toMatchObject({
      valid: true,
      reason: "verified",
      text: result.snippet,
    });

    const fabricatedResponse = await fetch(
      `http://${server.host}:${server.port}/api/search/provenance/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...result.provenance,
          byteStart: result.provenance.byteStart + 1,
        }),
      },
    );
    expect(fabricatedResponse.status).toBe(409);
    await expect(fabricatedResponse.json()).resolves.toMatchObject({
      valid: false,
      reason: "chunk-hash-mismatch",
      text: null,
    });
  });

  it("invalidates an old receipt after source edit and reconciliation", async () => {
    const relPath = "wiki/projects/changing-receipt.md";
    const firstContent = "# Changing receipt\n\nstaleprovenance first indexed bytes";
    const { vaultRoot, indexDbPath } = await createIndexedVaultWithPages([
      [relPath, firstContent],
    ]);
    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_DB_PATH: indexDbPath },
      voyageClient: null,
    });
    const firstSearch = await fetch(
      `http://${server.host}:${server.port}/api/search?q=staleprovenance`,
    );
    const oldReceipt = (await firstSearch.json()).results[0].provenance;

    await server.close();
    server = null;
    await writeVaultFile(
      vaultRoot,
      relPath,
      "# Changing receipt\n\nstaleprovenance replacement indexed bytes are different",
    );
    const writer = openIndexDb(indexDbPath);
    await reconcileIndex(writer, vaultRoot);
    writer.close();
    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_DB_PATH: indexDbPath },
      voyageClient: null,
    });

    const oldResolution = await fetch(
      `http://${server.host}:${server.port}/api/search/provenance/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(oldReceipt),
      },
    );
    expect(oldResolution.status).toBe(409);
    await expect(oldResolution.json()).resolves.toMatchObject({
      valid: false,
      reason: "source-hash-mismatch",
    });

    const nextSearch = await fetch(
      `http://${server.host}:${server.port}/api/search?q=staleprovenance`,
    );
    const nextResult = (await nextSearch.json()).results[0];
    expect(nextResult.provenance.sourceContentHash).not.toBe(oldReceipt.sourceContentHash);
    expect(nextResult.provenance.indexGeneration).toBe(oldReceipt.indexGeneration + 1);
    const nextResolution = await fetch(
      `http://${server.host}:${server.port}/api/search/provenance/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(nextResult.provenance),
      },
    );
    await expect(nextResolution.json()).resolves.toMatchObject({
      valid: true,
      text: nextResult.snippet,
    });
  });

  it("applies supported advanced params on the index search path", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const response = await fetch(
      `http://${server.host}:${server.port}/api/search?q=needle&scope=wiki&as_of=2026-01-01`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.searchBackend).toBe("index-lexical");
    expect(body.ignoredParams).toEqual([]);
    // Contract fields stay out of health warnings (SearchPage empty-state).
    expect(body.warnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^ignored-params:/)]),
    );
  });

  it("canonicalizes timestamp as_of to the inclusive stored validity day", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVaultWithPages([
      [
        "wiki/projects/expires-today.md",
        "---\ntitle: Expires today\ntype: projects\nvalid_until: 2026-07-23\n---\n\ntemporalneedle",
      ],
    ]);
    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_DB_PATH: indexDbPath },
      voyageClient: null,
    });

    const response = await fetch(
      `http://${server.host}:${server.port}/api/search?q=temporalneedle&as_of=2026-07-23T12:00:00Z`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results).toEqual([
      expect.objectContaining({ path: "wiki/projects/expires-today.md" }),
    ]);
  });

  it("applies index scope before the route candidate limit", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVaultWithPages([
      ["wiki/scoped.md", "# Scoped\n\nneedle"],
    ]);

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const response = await fetch(
      `http://${server.host}:${server.port}/api/search?q=needle&scope=raw&limit=1`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results).toEqual([]);
  });

  it("returns crystal result and provenance kinds from the default SQLite route", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVaultWithPages([
      [
        "wiki/crystals/example.md",
        "---\ntitle: Example crystal\ntype: crystal\n---\n\ncrystalneedle",
      ],
    ]);

    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_DB_PATH: indexDbPath },
      voyageClient: null,
    });

    const response = await fetch(
      `http://${server.host}:${server.port}/api/search?q=crystalneedle&scope=crystals`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results).toEqual([
      expect.objectContaining({
        path: "wiki/crystals/example.md",
        kind: "crystal",
        provenance: expect.objectContaining({
          path: "wiki/crystals/example.md",
          kind: "crystal",
        }),
      }),
    ]);
  });

  it("serves a type-defined crystal outside wiki/crystals only in crystal scope", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVaultWithPages([
      [
        "wiki/projects/typed-crystal.md",
        "---\ntitle: Typed crystal\ntype: crystal\n---\n\ntypedcrystalneedle",
      ],
    ]);

    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_DB_PATH: indexDbPath },
      voyageClient: null,
    });

    const crystalResponse = await fetch(
      `http://${server.host}:${server.port}/api/search?q=typedcrystalneedle&scope=crystals`,
    );
    const crystalBody = await crystalResponse.json();
    expect(crystalResponse.status).toBe(200);
    expect(crystalBody.results).toEqual([
      expect.objectContaining({
        path: "wiki/projects/typed-crystal.md",
        kind: "crystal",
        provenance: expect.objectContaining({
          kind: "crystal",
        }),
      }),
    ]);

    const wikiResponse = await fetch(
      `http://${server.host}:${server.port}/api/search?q=typedcrystalneedle&scope=wiki`,
    );
    const wikiBody = await wikiResponse.json();
    expect(wikiResponse.status).toBe(200);
    expect(wikiBody.results).toEqual([]);
  });

  it("returns stable 422 unsupported_params for explicit unsupported index controls", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const response = await fetch(
      `http://${server.host}:${server.port}/api/search` +
      "?q=needle&minScore=0.5&noRerank=true&noHyde=true&hydeExpansion=expanded&intent=procedure",
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "unsupported_params",
      unsupported_params: [
        "minScore",
        "noRerank",
        "noHyde",
        "hydeExpansion",
        "intent",
      ],
    });
  });

  it("rejects unsupported index controls even when their explicit value is blank", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();
    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_DB_PATH: indexDbPath },
      voyageClient: null,
    });

    for (const param of ["minScore", "hydeExpansion", "intent"] as const) {
      const response = await fetch(
        `http://${server.host}:${server.port}/api/search?q=needle&${param}=`,
      );

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        error: "unsupported_params",
        unsupported_params: [param],
      });
    }
  });

  it("serves default index search inline even when a vector executor is available", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();

    const searchExecutor = fakeSearchExecutor("lexical-plus-vector");

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
      searchExecutor,
    });

    const response = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(searchExecutor.search).not.toHaveBeenCalled();
    expect(body.results).toEqual([
      expect.objectContaining({
        path: "wiki/indexed.md",
        source: "index",
      }),
    ]);
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });
  it("keeps capabilities lexical when an executor is present but vector search is unavailable", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();
    const searchExecutor = fakeSearchExecutor("lexical-only");

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
        MEMORY_INDEX_VECTORS: "1",
      },
      voyageClient: null,
      searchExecutor,
    });

    const before = await fetch(
      `http://${server.host}:${server.port}/api/search/capabilities`,
    );
    await expect(before.json()).resolves.toMatchObject({
      searchBackend: "index-lexical",
    });

    const response = await fetch(
      `http://${server.host}:${server.port}/api/search?q=needle`,
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      searchBackend: "index-lexical",
      hybridMode: "lexical-only",
      vectorState: "unavailable",
    });

    const after = await fetch(
      `http://${server.host}:${server.port}/api/search/capabilities`,
    );
    await expect(after.json()).resolves.toMatchObject({
      searchBackend: body.searchBackend,
    });
  });


  it("routes index search through the configured SearchExecutor only when vectors are opted in", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();
    const searchExecutor = fakeSearchExecutor("lexical-plus-vector");

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
        MEMORY_INDEX_VECTORS: "1",
      },
      voyageClient: null,
      searchExecutor,
    });

    const response = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(searchExecutor.search).toHaveBeenCalledWith({
      query: "needle",
      limit: 5,
      cursor: null,
      scope: "all",
      includeArchived: false,
      asOf: undefined,
      agentId: undefined,
      userId: undefined,
      identityMode: "inclusive",
    });
    expect(body).toMatchObject({
      query: "needle",
      hybridMode: "lexical-plus-vector",
      vectorState: "ready",
      index: { ready: true },
      results: [expect.objectContaining({ path: "wiki/vector.md", source: "vector" })],
    });
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("falls back to inline lexical search when vector opt-in has no search process binary", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
        MEMORY_INDEX_VECTORS: "1",
        MEMORY_INDEX_SEARCH_PROCESS_PATH: join(tempDir!, "missing-search-process.mjs"),
      },
      voyageClient: null,
    });

    const response = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      query: "needle",
      degraded: false,
      results: [expect.objectContaining({ path: "wiki/indexed.md", source: "index" })],
    });
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("falls back to lexical index search when the vector SearchExecutor rejects without loading the legacy corpus", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();
    const searchExecutor = fakeSearchExecutor("lexical-plus-vector");
    searchExecutor.search.mockRejectedValueOnce(new Error("vector executor offline"));

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
        MEMORY_INDEX_VECTORS: "1",
      },
      voyageClient: null,
      searchExecutor,
    });

    const response = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(searchExecutor.search).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      query: "needle",
      degraded: true,
      warnings: ["search process unavailable: vector executor offline"],
      index: {
        ready: true,
        lastError: "vector executor offline",
      },
      results: [expect.objectContaining({ path: "wiki/indexed.md", source: "index" })],
    });
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("passes opaque index search cursors through to the configured SearchExecutor", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();
    const searchExecutor = fakeSearchExecutor("lexical-plus-vector");

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
        MEMORY_INDEX_VECTORS: "1",
      },
      voyageClient: null,
      searchExecutor,
    });

    const response = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5&cursor=opaque-token`);

    expect(response.status).toBe(200);
    expect(searchExecutor.search).toHaveBeenCalledWith({
      query: "needle",
      limit: 5,
      cursor: "opaque-token",
      scope: "all",
      includeArchived: false,
      asOf: undefined,
      agentId: undefined,
      userId: undefined,
      identityMode: "inclusive",
    });
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("uses the legacy search path when MEMORY_INDEX_SEARCH explicitly opts out", async () => {
    const { vaultRoot } = await createVault();
    const searchExecutor = fakeSearchExecutor("lexical-plus-vector");
    vi.mocked(loadSearchCorpus).mockResolvedValue({
      documents: [legacyDocument(vaultRoot)],
      errors: [],
      rawTruncated: false,
      scannedCounts: { wiki: 1, raw: 0, crystals: 0 },
    });

    server = await createServer({
      vaultRoot,
      port: 0,
      env: { MEMORY_INDEX_SEARCH: "0" },
      voyageClient: null,
      searchExecutor,
    });

    const response = await fetch(`http://${server.host}:${server.port}/api/search?q=legacy&noHyde=true`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results[0]?.path).toBe("wiki/legacy.md");
    expect(loadSearchCorpus).toHaveBeenCalledTimes(1);
    expect(searchExecutor.search).not.toHaveBeenCalled();
  });

  it("reports disabled index status when MEMORY_INDEX_SEARCH opts out", async () => {
    const { vaultRoot } = await createVault();
    const indexDbPath = join(tempDir!, "disabled", "index.db");

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_SEARCH: "0",
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const status = await fetch(`http://${server.host}:${server.port}/api/index-status`);
    const statusBody = await status.json();

    expect(status.status).toBe(200);
    expect(statusBody).toMatchObject({
      enabled: false,
      dbPath: indexDbPath,
      currentState: "disabled",
      ready: false,
      lastError: null,
    });
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("serves index search through the read connection while the writer owns an active WAL transaction", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();
    const parentPort = new FakeParentPort();
    let releaseWriter!: () => void;
    let writerStarted!: () => void;
    const writerStartedPromise = new Promise<void>((resolve) => {
      writerStarted = resolve;
    });
    const exitCodes: number[] = [];

    const writerReady = startIndexWriter({
      parentPort,
      reconcileIndexImpl: async (indexDb) => {
        indexDb.database.exec("BEGIN IMMEDIATE");
        writerStarted();
        await new Promise<void>((resolve) => {
          releaseWriter = resolve;
        });
        indexDb.database.exec("COMMIT");
        return { filesIndexed: 0, filesTombstoned: 0, chunks: 0, filesSkipped: 0 };
      },
      exit: (code) => {
        exitCodes.push(code);
      },
    });
    parentPort.emit("message", {
      vaultRoot,
      indexDbPath,
      debounceMs: 0,
      intervalMs: 0,
    });
    await writerReady;
    await writerStartedPromise;

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const response = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const body = await response.json();
    releaseWriter();
    parentPort.emit("message", { type: "shutdown" });
    await until(() => exitCodes.length > 0);

    expect(response.status).toBe(200);
    expect(body.results[0]?.path).toBe("wiki/indexed.md");
    expect(exitCodes).toEqual([0]);
  });

  it("returns non-blocking indexing status when index search is enabled before the writer creates the DB", async () => {
    const { vaultRoot } = await createVault();
    const indexDbPath = join(tempDir!, "missing", "index.db");

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const search = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const searchBody = await search.json();
    const status = await fetch(`http://${server.host}:${server.port}/api/index-status`);
    const statusBody = await status.json();

    expect(search.status).toBe(200);
    expect(searchBody).toMatchObject({
      query: "needle",
      results: [],
      warnings: ["indexing"],
      degraded: true,
      index: {
        dbPath: indexDbPath,
        currentState: "building",
        ready: false,
      },
    });
    expect(status.status).toBe(200);
    expect(statusBody).toMatchObject({
      enabled: true,
      dbPath: indexDbPath,
      currentState: "building",
      ready: false,
    });
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("reports repairing when the index DB exists but the read connection cannot open it", async () => {
    const { vaultRoot } = await createVault();
    const indexDbPath = join(tempDir!, "broken", "index.db");
    await mkdir(dirname(indexDbPath), { recursive: true });
    await writeFile(indexDbPath, "not a sqlite database", "utf8");

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const status = await fetch(`http://${server.host}:${server.port}/api/index-status`);
    const statusBody = await status.json();
    const search = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const searchBody = await search.json();

    expect(status.status).toBe(200);
    expect(statusBody).toMatchObject({
      enabled: true,
      dbPath: indexDbPath,
      currentState: "repairing",
      ready: false,
    });
    expect(statusBody.lastError).toEqual(expect.any(String));
    expect(search.status).toBe(200);
    expect(searchBody).toMatchObject({
      results: [],
      warnings: ["indexing"],
      degraded: true,
      index: {
        currentState: "repairing",
        ready: false,
      },
    });
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("treats an error reconcile state after a previous build as not ready", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();
    const indexDb = openIndexDb(indexDbPath);
    openDbs.push(indexDb);
    setMeta(indexDb, "activeReconcileState", "error");
    setMeta(indexDb, "lastReconcileError", "disk image is malformed");
    indexDb.close();
    openDbs.pop();

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const status = await fetch(`http://${server.host}:${server.port}/api/index-status`);
    const statusBody = await status.json();
    const search = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const searchBody = await search.json();

    expect(status.status).toBe(200);
    expect(statusBody).toMatchObject({
      currentState: "error",
      lastError: "disk image is malformed",
      ready: false,
    });
    expect(search.status).toBe(200);
    expect(searchBody).toMatchObject({
      degraded: true,
      warnings: ["indexing"],
      index: {
        currentState: "error",
        lastError: "disk image is malformed",
        ready: false,
      },
    });
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("reports skipped oversized files while serving the indexed remainder", async () => {
    const { vaultRoot } = await createVault();
    const indexDbPath = join(tempDir!, "index", "index.db");
    await writeVaultFile(vaultRoot, "raw/too-large.md", `# Too Large\n\n${"oversized ".repeat(20)}`);
    await writeVaultFile(vaultRoot, "wiki/indexed.md", "# Indexed\n\nneedle still indexed");
    const indexDb = openIndexDb(indexDbPath);
    openDbs.push(indexDb);
    await reconcileIndex(indexDb, vaultRoot, { maxFileBytes: 64 });
    indexDb.close();
    openDbs.pop();

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const status = await fetch(`http://${server.host}:${server.port}/api/index-status`);
    const statusBody = await status.json();
    const search = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const searchBody = await search.json();

    expect(status.status).toBe(200);
    expect(statusBody).toMatchObject({
      ready: true,
      chunkCount: 1,
      filesSkipped: 1,
      skippedFiles: [
        expect.objectContaining({
          relPath: "raw/too-large.md",
          errorState: "too-large",
        }),
      ],
    });
    expect(search.status).toBe(200);
    expect(searchBody.results).toEqual([
      expect.objectContaining({
        path: "wiki/indexed.md",
        source: "index",
      }),
    ]);
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("cursor-paginates index search results without loading the legacy corpus", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVaultWithPages([
      ["wiki/a.md", "# A\n\nneedle alpha"],
      ["wiki/b.md", "# B\n\nneedle beta"],
    ]);

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const first = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=1`);
    const firstBody = await first.json();
    const second = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=1&cursor=${firstBody.nextCursor}`);
    const secondBody = await second.json();

    expect(first.status).toBe(200);
    expect(firstBody.results).toHaveLength(1);
    expect(firstBody.results[0].path).toBe("wiki/a.md");
    expect(firstBody.nextCursor).toBe("1");
    expect(second.status).toBe(200);
    expect(secondBody.results).toHaveLength(1);
    expect(secondBody.results[0].path).toBe("wiki/b.md");
    expect(secondBody.nextCursor).toBeNull();
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("refreshes opaque cursors as invalid in the executor-absent lexical fallback", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVaultWithPages([
      ["wiki/a.md", "# A\n\nneedle alpha"],
      ["wiki/b.md", "# B\n\nneedle beta"],
    ]);
    const opaqueCursor = Buffer.from(JSON.stringify({ hybridMode: "lexical-plus-vector" }), "utf8").toString("base64url");

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
      searchExecutor: null,
    });

    const response = await fetch(
      `http://${server.host}:${server.port}/api/search?q=needle&limit=1&cursor=${opaqueCursor}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cursorStatus).toBe("invalid");
    expect(body.cursor).toBeNull();
    expect(body.warnings).toContain("cursor-invalid");
    expect(body.results).toHaveLength(1);
    expect(body.results[0].path).toBe("wiki/a.md");
    expect(body.nextCursor).toBe("1");
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("runs a deliberate TRUNCATE checkpoint after each writer reconcile", async () => {
    const parentPort = new FakeParentPort();
    const pragmas: string[] = [];
    const fakeDb = {
      path: "C:/tmp/index.db",
      database: {
        exec: vi.fn(),
        pragma: vi.fn((sql: string) => {
          pragmas.push(sql);
          return [];
        }),
        prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn() })),
        close: vi.fn(),
      },
      close: vi.fn(),
      integrityCheck: vi.fn(),
      rebuildFts: vi.fn(),
    } as unknown as IndexDb;

    const ready = startIndexWriter({
      parentPort,
      env: { MEMORY_INDEX_SEARCH: "0" },
      openIndexDbImpl: () => fakeDb,
      reconcileIndexImpl: async () => ({ filesIndexed: 1, filesTombstoned: 0, chunks: 1, filesSkipped: 0 }),
      createVectorEmbedClientImpl: async () => {
        throw new Error("vector embed client should not be created while index search is disabled");
      },
      backfillVectorsImpl: async () => {
        throw new Error("vector backfill should not run while index search is disabled");
      },
      exit: () => undefined,
    });
    parentPort.emit("message", {
      vaultRoot: "C:/vault",
      debounceMs: 0,
      intervalMs: 0,
    });
    await ready;
    await until(() => pragmas.includes("wal_checkpoint(TRUNCATE)"));

    expect(pragmas).toContain("wal_checkpoint(TRUNCATE)");
  });

  it("does not run vector backfill when index search is on but vectors are not opted in", async () => {
    const parentPort = new FakeParentPort();
    const calls: string[] = [];
    const fakeDb = {
      path: "C:/tmp/index.db",
      database: {
        exec: vi.fn(),
        pragma: vi.fn((sql: string) => {
          calls.push(sql);
          return [];
        }),
        prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn() })),
        close: vi.fn(),
      },
      close: vi.fn(),
      integrityCheck: vi.fn(),
      rebuildFts: vi.fn(),
    } as unknown as IndexDb;

    const ready = startIndexWriter({
      parentPort,
      env: { MEMORY_INDEX_SEARCH: "1" },
      openIndexDbImpl: () => fakeDb,
      reconcileIndexImpl: async () => {
        calls.push("reconcile");
        return { filesIndexed: 1, filesTombstoned: 0, chunks: 1, filesSkipped: 0 };
      },
      createVectorEmbedClientImpl: async () => {
        calls.push("create-vector-client");
        return {
          profile: profileFingerprint(),
          embed: async () => [vector(0)],
        };
      },
      backfillVectorsImpl: async () => {
        calls.push("backfill");
        return { cancelled: false, processed: 1, embedded: 1, reused: 0, failed: 0, stale: 0 };
      },
      exit: () => undefined,
    });
    parentPort.emit("message", {
      vaultRoot: "C:/vault",
      debounceMs: 0,
      intervalMs: 0,
    });
    await ready;
    await until(() => calls.includes("wal_checkpoint(TRUNCATE)"));

    expect(calls).toEqual(["reconcile", "wal_checkpoint(TRUNCATE)"]);
  });

  it("runs vector backfill after lexical reconcile and before checkpoint when vectors are opted in", async () => {
    const parentPort = new FakeParentPort();
    const calls: string[] = [];
    const fakeDb = {
      path: "C:/tmp/index.db",
      database: {
        exec: vi.fn(),
        pragma: vi.fn((sql: string) => {
          calls.push(sql);
          return [];
        }),
        prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn() })),
        close: vi.fn(),
      },
      close: vi.fn(),
      integrityCheck: vi.fn(),
      rebuildFts: vi.fn(),
    } as unknown as IndexDb;

    const ready = startIndexWriter({
      parentPort,
      env: { MEMORY_INDEX_VECTORS: "1" },
      openIndexDbImpl: () => fakeDb,
      reconcileIndexImpl: async () => {
        calls.push("reconcile");
        return { filesIndexed: 1, filesTombstoned: 0, chunks: 1, filesSkipped: 0 };
      },
      createVectorEmbedClientImpl: async () => ({
        profile: profileFingerprint(),
        embed: async () => [vector(0)],
      }),
      backfillVectorsImpl: async () => {
        calls.push("backfill");
        return { cancelled: false, processed: 1, embedded: 1, reused: 0, failed: 0, stale: 0 };
      },
      exit: () => undefined,
    });
    parentPort.emit("message", {
      vaultRoot: "C:/vault",
      debounceMs: 0,
      intervalMs: 0,
    });
    await ready;
    await until(() => calls.includes("wal_checkpoint(TRUNCATE)"));

    expect(calls).toEqual(["reconcile", "backfill", "wal_checkpoint(TRUNCATE)"]);
  });

  async function createIndexedVault(): Promise<{ vaultRoot: string; indexDbPath: string }> {
    return createIndexedVaultWithPages([["wiki/indexed.md", "# Indexed\n\nneedle needle precise match"]]);
  }

  async function createIndexedVaultWithPages(
    pages: Array<readonly [relPath: string, content: string]>,
  ): Promise<{ vaultRoot: string; indexDbPath: string }> {
    const { vaultRoot } = await createVault();
    const indexDbPath = join(tempDir, "index", "index.db");
    for (const [relPath, content] of pages) {
      await writeVaultFile(vaultRoot, relPath, content);
    }

    const indexDb = openIndexDb(indexDbPath);
    openDbs.push(indexDb);
    await reconcileIndex(indexDb, vaultRoot);
    indexDb.close();
    openDbs.pop();

    return { vaultRoot, indexDbPath };
  }

  async function createVault(): Promise<{ vaultRoot: string }> {
    tempDir = await mkdtemp(join(tmpdir(), "memory-dashboard-index-search-"));
    const vaultRoot = join(tempDir, "vault");
    await mkdir(vaultRoot, { recursive: true });
    return { vaultRoot };
  }

  function legacyDocument(vaultRoot: string) {
    return {
      kind: "wiki" as const,
      relPath: "wiki/legacy.md",
      fullPath: join(vaultRoot, "wiki", "legacy.md"),
      title: "Legacy",
      type: "note",
      status: "active",
      cognitiveType: "semantic" as const,
      confidence: null,
      tags: [],
      relations: {},
      source: "test",
      session: null,
      importedFrom: null,
      body: "legacy search body",
      snippetSource: "legacy search body",
      created: null,
      observedAt: null,
      updated: null,
      mtime: new Date().toISOString(),
      sizeBytes: 18,
    };
  }

  function fakeSearchExecutor(hybridMode: "lexical-only" | "lexical-plus-vector"): SearchExecutor & {
    search: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  } {
    return {
      search: vi.fn(async (request: { query: string }) => ({
        query: request.query,
        results: [
          {
            path: "wiki/vector.md",
            title: "Vector",
            snippet: "semantic payload",
            score: 1,
            source: "vector",
            sources: [{ source: "vector", rank: 1 }],
            kind: "wiki" as const,
            provenance: {
              path: "wiki/vector.md",
              kind: "wiki" as const,
              dominantSource: "vector",
              signals: [{ source: "vector", rank: 1 }],
              confidence: null,
              sourceFactCount: 0,
              derivedFromCount: 0,
              tier: "medium" as const,
            },
          },
        ],
        warnings: [],
        timings: {
          corpusMs: 0,
          refreshMs: 0,
          embedQueryMs: 0,
          bm25Ms: 0,
          vectorMs: 0,
          exactMs: 0,
          graphMs: 0,
          graphSpreadMs: 0,
          metadataMs: 0,
          rrfMs: 0,
          rerankMs: 0,
          totalMs: 0,
          intentClassification: {
            label: "open-ended" as const,
            confidence: 0.5,
            method: "fallback" as const,
            latencyMs: 0,
          },
        },
        degraded: false,
        hyde: { used: false, reason: "disabled-by-flag" as const },
        corpusErrorCount: 0,
        bm25Cache: {
          indexCacheHit: true,
          documentCount: 1,
          tokenCacheHits: 0,
          tokenCacheMisses: 0,
        },
        vectorState: hybridMode === "lexical-plus-vector" ? "ready" as const : "unavailable" as const,
        vectorCoverage: hybridMode === "lexical-plus-vector"
          ? { embeddedEligible: 1, totalEligible: 1 }
          : { embeddedEligible: 0, totalEligible: 1 },
        hybridMode,
        cursor: null,
        nextCursor: null,
      })),
      close: vi.fn(),
    };
  }

  function profileFingerprint(
    overrides: Partial<Omit<EmbeddingProfileFingerprint, "profileId">> = {},
  ): EmbeddingProfileFingerprint {
    return createEmbeddingProfileFingerprint({
      provider: "local",
      runtime: "onnxruntime-node",
      runtimeVersion: "1.22.0",
      modelId: "BAAI/bge-small-en-v1.5",
      modelRevision: "refs/pr/5",
      modelHash: "model-a",
      tokenizerHash: "tokenizer-a",
      pooling: "cls",
      normalization: "l2",
      dtype: "binary-int8",
      dimension: 384,
      prefixStrategy: "bge-passage",
      chunkerVersion: "phase3-v1",
      payloadRecipe: "heading-path-v1",
      maxTokenPolicy: "truncate-512",
      ...overrides,
    });
  }

  function vector(index: number): Float32Array {
    const values = new Float32Array(384);
    values[index] = 1;
    return values;
  }

  async function until(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("condition was not met");
  }

  async function writeVaultFile(vaultRoot: string, relPath: string, content: string): Promise<void> {
    const path = join(vaultRoot, ...relPath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  function setMeta(indexDb: IndexDb, key: string, value: string): void {
    indexDb.database
      .prepare<[string, string]>("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }
});
