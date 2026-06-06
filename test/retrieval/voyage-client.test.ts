import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeVoyageClient,
  resolveVoyageApiKey,
  VoyageRateLimitedError,
  VoyageTimeoutError,
  VoyageUnavailableError,
} from "../../src/retrieval/voyage-client.js";

const sdk = vi.hoisted(() => ({
  constructor: vi.fn(),
  embed: vi.fn(),
  rerank: vi.fn(),
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn().mockImplementation((options: unknown) => {
    sdk.constructor(options);
    return { embed: sdk.embed, rerank: sdk.rerank };
  }),
}));

vi.mock("node:module", () => ({
  createRequire: vi.fn(() => (id: string) => {
    if (id !== "voyageai") {
      throw new Error(`unexpected require: ${id}`);
    }
    return {
      VoyageAIClient: vi.fn().mockImplementation((options: unknown) => {
        sdk.constructor(options);
        return { embed: sdk.embed, rerank: sdk.rerank };
      }),
    };
  }),
}));

describe("Voyage client wrapper", () => {
  const originalApiKey = process.env["VOYAGE_API_KEY"];

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["VOYAGE_API_KEY"];
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env["VOYAGE_API_KEY"];
    } else {
      process.env["VOYAGE_API_KEY"] = originalApiKey;
    }
  });

  it("makeVoyageClient + embed happy path", async () => {
    sdk.embed.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
      model: "voyage-4-large",
      usage: { totalTokens: 12 },
    });
    const client = makeVoyageClient({ apiKey: "test-key" });

    await expect(client.embed(["a", "b"])).resolves.toEqual({
      vectors: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      model: "voyage-4-large",
      dim: 2,
      inputTokens: 12,
    });
    expect(sdk.constructor).toHaveBeenCalledWith({ apiKey: "test-key" });
    expect(sdk.embed).toHaveBeenCalledWith(
      {
        input: ["a", "b"],
        model: "voyage-4-large",
        inputType: "document",
        outputDimension: 2048,
      },
      { timeoutInSeconds: 60 },
    );
  });

  it('embed with inputType="query"', async () => {
    sdk.embed.mockResolvedValue({
      data: [{ embedding: [0.5, 0.6] }],
      model: "voyage-4-large",
    });
    const client = makeVoyageClient({ apiKey: "test-key" });

    await client.embed(["query text"], { inputType: "query" });

    expect(sdk.embed).toHaveBeenCalledWith(
      expect.objectContaining({ inputType: "query" }),
      expect.any(Object),
    );
  });

  it("embed 429 normalizes to VoyageRateLimitedError", async () => {
    sdk.embed.mockRejectedValue(Object.assign(new Error("rate limit"), { status: 429 }));
    const client = makeVoyageClient({ apiKey: "test-key" });

    await expect(client.embed(["a"])).rejects.toBeInstanceOf(
      VoyageRateLimitedError,
    );
  });

  it("embed AbortSignal fires -> VoyageTimeoutError", async () => {
    sdk.embed.mockReturnValue(new Promise(() => undefined));
    const client = makeVoyageClient({ apiKey: "test-key" });
    const controller = new AbortController();
    const promise = client.embed(["a"], { signal: controller.signal });

    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(VoyageTimeoutError);
  });

  it("rerank happy path", async () => {
    sdk.rerank.mockResolvedValue({
      data: [
        { index: 2, relevanceScore: 0.91 },
        { index: 0, relevanceScore: 0.75 },
      ],
      model: "rerank-2.5",
    });
    const client = makeVoyageClient({ apiKey: "test-key" });

    await expect(client.rerank("query", ["doc1", "doc2", "doc3"])).resolves.toEqual({
      ranked: [
        { index: 2, score: 0.91, document: "doc3" },
        { index: 0, score: 0.75, document: "doc1" },
      ],
      model: "rerank-2.5",
    });
    expect(sdk.rerank).toHaveBeenCalledWith(
      {
        query: "query",
        documents: ["doc1", "doc2", "doc3"],
        model: "rerank-2.5",
        returnDocuments: true,
      },
      { timeoutInSeconds: 60 },
    );
  });

  it("resolveVoyageApiKey reads env only and ignores config.yaml secrets", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "voyage-key-"));
    try {
      process.env["VOYAGE_API_KEY"] = "env-key";
      await writeFile(join(tmp, "config.yaml"), "voyage:\n  api_key: config-key\n");
      await expect(resolveVoyageApiKey(tmp)).resolves.toBe("env-key");

      delete process.env["VOYAGE_API_KEY"];
      await expect(resolveVoyageApiKey(tmp)).rejects.toThrow(
        "VOYAGE_API_KEY not set in env",
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("resolveVoyageApiKey errors when VOYAGE_API_KEY is missing", async () => {
    await expect(resolveVoyageApiKey()).rejects.toBeInstanceOf(
      VoyageUnavailableError,
    );
    await expect(resolveVoyageApiKey()).rejects.toThrow(
      "VOYAGE_API_KEY not set in env",
    );
  });
});
