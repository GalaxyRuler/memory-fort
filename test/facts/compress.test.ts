import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compressSession } from "../../src/facts/compress.js";
import { runCompress } from "../../src/cli/commands/compress.js";
import type { LLMProvider } from "../../src/llm/types.js";

describe("memory fact compression", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-compress-"));
    await writeFileAt("raw/2026-05-31/session-a.md", [
      "---",
      "type: raw-session",
      "title: Session A",
      "created: 2026-05-31",
      "updated: 2026-05-31",
      "session: session-a",
      "---",
      "",
      "Memory System shipped Phase 3 retrieval.",
      "OPENROUTER_API_KEY=sk-live-secret",
    ].join("\n"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("compresses one raw session into structured importance-scored facts with secrets redacted", async () => {
    const llm = fakeCompressionLLM([{
      title: "Memory System retrieval shipped",
      facts: ["Memory System shipped Phase 3 retrieval."],
      narrative: "Phase 3 retrieval became available.",
      concepts: ["Memory System", "retrieval"],
      files: ["src/retrieval/search.ts"],
      importance: 8,
    }]);

    const facts = await compressSession({
      rawText: await readFile(join(tmp, "raw", "2026-05-31", "session-a.md"), "utf-8"),
      rawRelPath: "raw/2026-05-31/session-a.md",
      sessionId: "session-a",
      observedAt: "2026-05-31T00:00:00.000Z",
      llm,
    });

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      title: "Memory System retrieval shipped",
      importance: 8,
      sessionId: "session-a",
      sourceRawPath: "raw/2026-05-31/session-a.md",
    });
    expect(vi.mocked(llm.chat).mock.calls[0]![0].messages.at(-1)!.content).not.toContain("sk-live-secret");
  });

  it("stores facts once per raw session and skips compressed sessions on rerun", async () => {
    const llm = fakeCompressionLLM([{
      title: "Memory System retrieval shipped",
      facts: ["Memory System shipped Phase 3 retrieval."],
      narrative: "Phase 3 retrieval became available.",
      concepts: ["Memory System"],
      files: [],
      importance: 8,
    }]);

    const first = await runCompress({
      vaultRoot: tmp,
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:00.000Z"),
    });
    const second = await runCompress({
      vaultRoot: tmp,
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:01:00.000Z"),
    });

    expect(first.summary).toMatchObject({ compressed: 1, skipped: 0, factsWritten: 1 });
    expect(second.summary).toMatchObject({ compressed: 0, skipped: 1, factsWritten: 0 });
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(existsSync(join(tmp, "facts", "2026-05-31", "session-a.json"))).toBe(true);
    const state = JSON.parse(await readFile(join(tmp, "state", "compile-state.json"), "utf-8"));
    expect(state.compressed["raw/2026-05-31/session-a.md"].bytes).toBeGreaterThan(0);
  });

  async function writeFileAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function fakeCompressionLLM(facts: Array<Record<string, unknown>>): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async () => ({
      model: "llama3.2",
      finishReason: "stop",
      rawProviderName: "ollama",
      tokensUsed: { prompt: 20, completion: 8, total: 28 },
      content: [
        "```json",
        JSON.stringify({ facts }),
        "```",
      ].join("\n"),
    })),
  };
}
