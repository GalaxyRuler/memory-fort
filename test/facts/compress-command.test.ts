import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCompress } from "../../src/cli/commands/compress.js";
import { readCompileStateFile, readCompressedMap } from "../../src/compile/state.js";
import { factFileRelPath } from "../../src/facts/store.js";
import type { LLMProvider, LLMRequest } from "../../src/llm/types.js";

// Fake provider that echoes which chunk it saw into a fact title, so we can prove
// which windows contributed facts to the merged file.
function chunkEchoLlm(): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async (request: LLMRequest) => {
      const prompt = request.messages.at(-1)?.content ?? "";
      const chunk = /Chunk (\d+) of/.exec(prompt)?.[1] ?? "1";
      return {
        model: "llama3.2",
        finishReason: "stop" as const,
        rawProviderName: "ollama",
        tokensUsed: { prompt: 10, completion: 5, total: 15 },
        content: [
          "```json",
          JSON.stringify({
            facts: [{
              title: `Window fact from chunk ${chunk}`,
              facts: [`fact ${chunk}`],
              narrative: `narrative ${chunk}`,
              concepts: ["concept"],
              files: [],
              importance: 5,
              type: "fact",
            }],
          }),
          "```",
        ].join("\n"),
      };
    }),
  };
}

const CONFIG = {
  llm: { provider: "ollama", model: "llama3.2" },
  compress: { chunk_threshold_bytes: 1_500, max_chunks: 2 },
};

function opts(root: string, config: unknown = CONFIG) {
  return {
    vaultRoot: root,
    apply: true,
    configLoader: async () => config as Record<string, unknown>,
    llmFactory: () => chunkEchoLlm(),
    env: {},
    now: new Date("2026-07-17T12:00:00.000Z"),
    logger: () => undefined,
  };
}

describe("compress resumable command", () => {
  let root: string;
  const relPath = "raw/2026-07-17/session-a.md";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compress-cmd-"));
    await mkdir(join(root, "raw", "2026-07-17"), { recursive: true });
    // ~6 chunks at 1500-byte windows.
    const body = Array.from({ length: 6 }, (_, i) =>
      `## [10:0${i}:00] Prompt\n${"x".repeat(1_200)} marker-${i}\n`,
    ).join("");
    await writeFile(join(root, relPath), `session: session-a\n${body}`, "utf-8");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function cursor(): Promise<{ chunkCursor?: number; chunkTotal?: number; chunkBytes?: number }> {
    return readCompressedMap(await readCompileStateFile(root))[relPath] ?? {};
  }
  async function factTitles(): Promise<string> {
    const factRel = factFileRelPath(relPath, "session-a");
    const parsed = JSON.parse(await readFile(join(root, ...factRel.split("/")), "utf-8")) as { facts: Array<{ title: string }> };
    return parsed.facts.map((f) => f.title).join(" | ");
  }

  it("advances a cursor across passes and merges every window's facts (no loss)", async () => {
    await runCompress(opts(root));
    let w = await cursor();
    expect(w.chunkCursor).toBe(2);
    expect(w.chunkTotal).toBeGreaterThan(2);

    await runCompress(opts(root));
    w = await cursor();
    expect(w.chunkCursor).toBe(4);

    // Drain to completion.
    for (let i = 0; i < 10; i += 1) {
      const r = await runCompress(opts(root));
      if (r.files.find((f) => f.path === relPath)?.reason === "already compressed") break;
    }
    w = await cursor();
    expect(w.chunkCursor).toBeUndefined(); // complete: cursor fields cleared

    const titles = await factTitles();
    expect(titles).toContain("chunk 1"); // first window survived all the merges
    expect(titles).toContain("chunk 5"); // a late window is present
  });

  it("restarts from chunk 0 when the chunking config changes between passes", async () => {
    await runCompress(opts(root));
    expect((await cursor()).chunkBytes).toBe(1_500);

    const changed = { ...CONFIG, compress: { chunk_threshold_bytes: 3_000, max_chunks: 2 } };
    await runCompress(opts(root, changed));
    // New fingerprint recorded; the file was re-chunked, not resumed at the old cursor.
    expect((await cursor()).chunkBytes).toBe(3_000);
  });

  it("does NOT advance the cursor while dropping earlier windows when the prior fact file is malformed", async () => {
    await runCompress(opts(root));
    expect((await cursor()).chunkCursor).toBe(2);

    // Corrupt the prior fact artifact before the resume pass.
    const factRel = factFileRelPath(relPath, "session-a");
    await writeFile(join(root, ...factRel.split("/")), "{ this is not valid json", "utf-8");

    await runCompress(opts(root));

    // Conservation: rather than merging window-3 onto a lost prior and advancing
    // to cursor 4, the pass restarts from chunk 0 — the fact file is valid again
    // and contains the first window's facts.
    const titles = await factTitles();
    expect(titles).toContain("chunk 1");
    expect((await cursor()).chunkCursor).toBe(2); // reprocessed [0,2), not advanced to 4
  });
});
