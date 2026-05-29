import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionStartBody } from "../../src/hooks/session-start.js";
import { logObservation } from "../../src/mcp/server.js";
import { runSearch } from "../../src/retrieval/search.js";
import type { EmbedClient } from "../../src/retrieval/refresh.js";
import type { VoyageClient } from "../../src/retrieval/voyage-client.js";

describe("feedback-loop round trip", () => {
  let tmp: string;
  let oldMemoryRoot: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "feedback-loop-"));
    oldMemoryRoot = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
    await mkdir(join(tmp, "wiki"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "preferences.md"),
      [
        "---",
        "type: references",
        "title: Operator Preferences",
        "created: 2026-05-28",
        "updated: 2026-05-28",
        "tags: [preference]",
        "confidence: 1",
        "---",
        "Remember durable preferences.",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    if (oldMemoryRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = oldMemoryRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  it("logs a unique observation and immediately returns it via session-start and lexical search", async () => {
    const token = "ROUNDTRIP-FRESH-4-8";
    await logObservation(
      {
        text: `${token} feedback loop freshness check`,
        tags: ["preference"],
        confidence: 1,
        source: "manual",
      },
      {
        now: () => new Date("2026-05-29T12:34:56.000Z"),
        sessionId: () => "roundtrip",
        commitVaultChange: vi.fn(async () => ({ kind: "no-changes" as const })),
      },
    );

    const writes: string[] = [];
    await sessionStartBody({}, { write: (text) => writes.push(text) });
    expect(writes.join("")).toContain(token);

    const search = await runSearch({
      query: token,
      noHyde: true,
      noRerank: true,
      vaultRoot: tmp,
      embedClient: unavailableEmbedClient(),
      voyageClient: unavailableVoyageClient(),
    });

    expect(search.results[0]?.path).toBe("raw/2026-05-29/manual-roundtrip.md");
    expect(search.results[0]?.sources.some((source) => source.source === "bm25")).toBe(true);
  });
});

function unavailableEmbedClient(): EmbedClient {
  return {
    embed: vi.fn(async () => {
      throw new Error("embedder unavailable");
    }),
  };
}

function unavailableVoyageClient(): VoyageClient {
  return {
    embed: vi.fn(async () => {
      throw new Error("embedder unavailable");
    }),
    rerank: vi.fn(async () => {
      throw new Error("rerank unavailable");
    }),
  };
}
