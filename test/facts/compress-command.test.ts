import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCompress } from "../../src/cli/commands/compress.js";
import { runCompactRaw } from "../../src/cli/commands/compact-raw.js";
import { formatToolUseBlock } from "../../src/hooks/raw-file.js";
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
      const evidence = evidenceFromPrompt(prompt);
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
              facts: [evidence],
              narrative: evidence,
              concepts: ["concept"],
              files: [],
              importance: 5,
              type: "fact",
              evidence,
            }],
          }),
          "```",
        ].join("\n"),
      };
    }),
  };
}

function evidenceFromPrompt(prompt: string): string {
  return /Session text:\n```markdown\n([\s\S]*?)\n```/.exec(prompt)?.[1] ?? prompt;
}

const CONFIG = {
  llm: { provider: "ollama", model: "llama3.2" },
  compile: { faithfulness_check: false },
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

    // Drain to completion, capturing the pass that actually completes the file.
    let completing: { chunksCompressed?: number; totalChunks?: number } | undefined;
    for (let i = 0; i < 10; i += 1) {
      const r = await runCompress(opts(root));
      const entry = r.files.find((f) => f.path === relPath);
      if (entry?.reason === "already compressed") break;
      if (entry?.outcome === "compressed") completing = entry;
    }
    w = await cursor();
    expect(w.chunkCursor).toBeUndefined(); // complete: cursor fields cleared

    // F8: the completing pass's RESULT reports full coverage, not just the last
    // window (the CLI formatter reads this).
    expect(completing?.chunksCompressed).toBe(completing?.totalChunks);

    const titles = await factTitles();
    expect(titles).toContain("chunk 1"); // first window survived all the merges
    expect(titles).toContain("chunk 5"); // a late window is present
  });

  it("does not reintroduce facts from compact-raw archive content into the live fact corpus", async () => {
    // A fact extracted from rich ToolUse output is intentionally discarded when
    // compact-raw removes that source text from the live file. The retained
    // archive remains inventory only and is never read to merge old facts back.
    const compactRel = "raw/2026-07-16/session-compact.md";
    await mkdir(join(root, "raw", "2026-07-16"), { recursive: true });
    const bigBlock = formatToolUseBlock({
      toolName: "Bash",
      toolInput: { command: "generate" },
      toolOutput: `${"y".repeat(2_000)} MIDDLE-ONLY-MARKER ${"y".repeat(2_000)}`,
      now: new Date("2026-07-16T10:00:00.000Z"),
      maxInputBytes: 8192,
      maxOutputBytes: 8192,
    });
    await writeFile(join(root, compactRel), `session: session-compact\n${bigBlock}`, "utf-8");

    const contentAwareLlm: LLMProvider = {
      providerName: "ollama",
      modelName: "llama3.2",
      chat: vi.fn(async (request: LLMRequest) => {
        const prompt = request.messages.at(-1)?.content ?? "";
        const title = prompt.includes("MIDDLE-ONLY-MARKER") ? "Middle-only fact" : "Compacted fallback";
        const evidence = evidenceFromPrompt(prompt);
        return {
          model: "llama3.2",
          finishReason: "stop" as const,
          rawProviderName: "ollama",
          content: [
            "```json",
            JSON.stringify({ facts: [{ title, facts: [evidence], narrative: evidence, concepts: ["c"], files: [], importance: 5, evidence }] }),
            "```",
          ].join("\n"),
        };
      }),
    };
    const bigOpts = {
      vaultRoot: root,
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" }, compile: { faithfulness_check: false } }),
      llmFactory: () => contentAwareLlm,
      env: {},
      now: new Date("2026-07-16T12:00:00.000Z"),
      logger: () => undefined,
    };

    await runCompress(bigOpts);
    const factRel = factFileRelPath(compactRel, "session-compact");
    let factBytes = await readFile(join(root, ...factRel.split("/")), "utf-8");
    expect(factBytes).toContain("Middle-only fact");

    await runCompactRaw({
      vaultRoot: root,
      mode: "apply",
      maxInputBytes: 100,
      maxOutputBytes: 100,
      commitVaultChange: vi.fn(async () => ({ kind: "no-changes" as const })) as never,
    });
    const liveAfter = await readFile(join(root, compactRel), "utf-8");
    expect(liveAfter).not.toContain("MIDDLE-ONLY-MARKER"); // source content is gone from the live file

    await runCompress(bigOpts); // bytes changed -> restart from live compacted content only
    factBytes = await readFile(join(root, ...factRel.split("/")), "utf-8");
    expect(factBytes).not.toContain("Middle-only fact");
    expect(factBytes).toContain("Compacted fallback");
  });

  it("re-compresses a same-BYTE-LENGTH in-place edit instead of reporting 'already compressed'", async () => {
    // Audit N1 (the original content-blind-watermark killer): a same-size edit
    // used to read as complete via the size-only watermark and get suppressed.
    const rel = "raw/2026-07-17/session-sz.md";
    await writeFile(join(root, rel), "session: session-sz\n## [10:00:00] Prompt\nOLD-MARKER x\n", "utf-8");
    const echo: LLMProvider = {
      providerName: "ollama", modelName: "llama3.2",
      chat: vi.fn(async (req: LLMRequest) => {
        const prompt = req.messages.at(-1)?.content ?? "";
        const title = prompt.includes("OLD-MARKER") ? "Old fact" : "New fact";
        const evidence = evidenceFromPrompt(prompt);
        return { model: "llama3.2", finishReason: "stop" as const, rawProviderName: "ollama",
          content: ["```json", JSON.stringify({ facts: [{ title, facts: [evidence], narrative: evidence, concepts: ["c"], files: [], importance: 5, evidence }] }), "```"].join("\n") };
      }),
    };
    const o = { ...opts(root), llmFactory: () => echo };
    await runCompress(o);
    const factRel = factFileRelPath(rel, "session-sz");
    expect(await readFile(join(root, ...factRel.split("/")), "utf-8")).toContain("Old fact");

    // Overwrite with the SAME byte length, different content, bumped mtime.
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(join(root, rel), "session: session-sz\n## [10:00:00] Prompt\nNEW-MARKER x\n", "utf-8");
    const r2 = await runCompress(o);
    expect(r2.files.find((f) => f.path === rel)?.outcome).toBe("compressed"); // NOT "skipped/already compressed"
    const after = await readFile(join(root, ...factRel.split("/")), "utf-8");
    expect(after).toContain("New fact");
    expect(after).not.toContain("Old fact");
  });

  it("never carries retained archive facts back into the live fact corpus after compaction", async () => {
    const rel = "raw/2026-07-16/session-lin.md";
    await mkdir(join(root, "raw", "2026-07-16"), { recursive: true });
    const block = formatToolUseBlock({
      toolName: "Bash", toolInput: { command: "x" },
      toolOutput: `${"y".repeat(2_000)} MIDDLE-ONLY-MARKER ${"y".repeat(2_000)}`,
      now: new Date("2026-07-16T10:00:00.000Z"), maxInputBytes: 8192, maxOutputBytes: 8192,
    });
    await writeFile(join(root, rel), `session: session-lin\n${block}`, "utf-8");
    const aware: LLMProvider = {
      providerName: "ollama", modelName: "llama3.2",
      chat: vi.fn(async (req: LLMRequest) => {
        const p = req.messages.at(-1)?.content ?? "";
        const title = p.includes("MIDDLE-ONLY-MARKER") ? "Middle fact" : p.includes("FINAL-EDIT") ? "Final fact" : "Compacted fallback";
        const evidence = evidenceFromPrompt(p);
        return { model: "llama3.2", finishReason: "stop" as const, rawProviderName: "ollama",
          content: ["```json", JSON.stringify({ facts: [{ title, facts: [evidence], narrative: evidence, concepts: ["c"], files: [], importance: 5, evidence }] }), "```"].join("\n") };
      }),
    };
    // Large single-window config so the first pass sees the whole block and
    // extracts "Middle fact" (not a tiny-chunk sample that misses the middle).
    const o = {
      vaultRoot: root, apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" }, compile: { faithfulness_check: false } }),
      llmFactory: () => aware, env: {}, now: new Date("2026-07-16T12:00:00.000Z"), logger: () => undefined,
    };
    await runCompress(o);                                      // extract "Middle fact"
    await runCompactRaw({ vaultRoot: root, mode: "apply", maxInputBytes: 100, maxOutputBytes: 100, commitVaultChange: vi.fn(async () => ({ kind: "no-changes" as const })) as never });
    await runCompress(o);                                      // compaction restart: rederive only from live compacted content
    const factRel = factFileRelPath(rel, "session-lin");
    const afterCompaction = await readFile(join(root, ...factRel.split("/")), "utf-8");
    expect(afterCompaction).toContain("Compacted fallback");
    expect(afterCompaction).not.toContain("Middle fact");

    // Later unrelated edit is likewise derived solely from the live source.
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(join(root, rel), "session: session-lin\n## [10:00:00] Prompt\nFINAL-EDIT only\n", "utf-8");
    await runCompress(o);
    const after = await readFile(join(root, ...factRel.split("/")), "utf-8");
    expect(after).toContain("Final fact");
    expect(after).not.toContain("Middle fact"); // stale fact NOT retained forever
  });

  it("does NOT retain stale facts when the raw is edited in place with no compaction lineage", async () => {
    // Audit finding N4: a genuine in-place edit (no compact-archive copy) must
    // discard facts about removed content, not preserve them forever. Only
    // compaction lineage justifies merge-on-restart.
    const editRel = "raw/2026-07-16/session-edit.md";
    await mkdir(join(root, "raw", "2026-07-16"), { recursive: true });
    const contentAwareLlm: LLMProvider = {
      providerName: "ollama",
      modelName: "llama3.2",
      chat: vi.fn(async (request: LLMRequest) => {
        const prompt = request.messages.at(-1)?.content ?? "";
        const title = prompt.includes("OLD-MARKER") ? "Old fact" : "New fact";
        const evidence = evidenceFromPrompt(prompt);
        return {
          model: "llama3.2",
          finishReason: "stop" as const,
          rawProviderName: "ollama",
          content: ["```json", JSON.stringify({ facts: [{ title, facts: [evidence], narrative: evidence, concepts: ["c"], files: [], importance: 5, evidence }] }), "```"].join("\n"),
        };
      }),
    };
    const editOpts = {
      vaultRoot: root,
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" }, compile: { faithfulness_check: false } }),
      llmFactory: () => contentAwareLlm,
      env: {},
      now: new Date("2026-07-16T12:00:00.000Z"),
      logger: () => undefined,
    };

    await writeFile(join(root, editRel), "session: session-edit\n## [10:00:00] Prompt\nOLD-MARKER content here\n", "utf-8");
    await runCompress(editOpts);
    const factRel = factFileRelPath(editRel, "session-edit");
    expect(await readFile(join(root, ...factRel.split("/")), "utf-8")).toContain("Old fact");

    // Edit in place (different bytes) WITHOUT compact-raw — no archive copy.
    await writeFile(join(root, editRel), "session: session-edit\n## [10:00:00] Prompt\nNEW-MARKER only\n", "utf-8");
    await runCompress(editOpts);

    const after = await readFile(join(root, ...factRel.split("/")), "utf-8");
    expect(after).toContain("New fact");
    expect(after).not.toContain("Old fact"); // stale fact about removed content is dropped
  });

  it("quarantines a persistently-malformed file after N attempts instead of retrying forever", async () => {
    // Audit finding N5: a file whose compression always fails held the cursor
    // and was re-attempted every run (unbounded cost / drain wedge). It must be
    // retried a bounded number of times, then skipped (left for compile).
    const badRel = "raw/2026-07-17/session-bad.md";
    await writeFile(join(root, badRel), "session: session-bad\n## [10:00:00] Prompt\nsome content\n", "utf-8");
    const malformedLlm: LLMProvider = {
      providerName: "ollama",
      modelName: "llama3.2",
      chat: vi.fn(async () => ({
        model: "llama3.2",
        finishReason: "stop" as const,
        rawProviderName: "ollama",
        content: "not json at all",
      })),
    };
    const badOpts = { ...opts(root), llmFactory: () => malformedLlm };

    // First three runs fail (retrying).
    for (let i = 0; i < 3; i += 1) {
      const r = await runCompress(badOpts);
      expect(r.files.find((f) => f.path === badRel)?.outcome).toBe("failed");
    }
    // Fourth run: quarantined, not retried — no LLM call, distinct skip reason.
    const chatBefore = (malformedLlm.chat as ReturnType<typeof vi.fn>).mock.calls.length;
    const after = await runCompress(badOpts);
    const entry = after.files.find((f) => f.path === badRel);
    expect(entry?.outcome).toBe("skipped");
    expect(entry?.reason).toContain("quarantined");
    expect((malformedLlm.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(chatBefore); // no further attempts
  });

  it("restarts from chunk 0 when the chunking config changes between passes", async () => {
    await runCompress(opts(root));
    expect((await cursor()).chunkBytes).toBe(1_500);

    const changed = { ...CONFIG, compress: { chunk_threshold_bytes: 3_000, max_chunks: 2 } };
    await runCompress(opts(root, changed));
    // New fingerprint recorded; the file was re-chunked, not resumed at the old cursor.
    expect((await cursor()).chunkBytes).toBe(3_000);
  });

  it("does NOT advance over earlier windows when the prior fact file is semantically corrupted (parseable but invalid facts)", async () => {
    await runCompress(opts(root));
    expect((await cursor()).chunkCursor).toBe(2);

    // Parseable JSON with a facts array whose members are all invalid — the
    // reader filters them to []. Resuming onto this would silently lose the
    // first window's facts while advancing the cursor (audit finding 1).
    const factRel = factFileRelPath(relPath, "session-a");
    await writeFile(join(root, ...factRel.split("/")), JSON.stringify({ facts: [{}] }), "utf-8");

    await runCompress(opts(root));

    const titles = await factTitles();
    expect(titles).toContain("chunk 1"); // restarted from 0 and re-extracted, not resumed onto garbage
    expect((await cursor()).chunkCursor).toBe(2); // reprocessed [0,2), did not advance to 4
  });

  it("fails the file (no facts, no watermark) when a stop response is malformed instead of recording empty complete coverage", async () => {
    const malformedLlm: LLMProvider = {
      providerName: "ollama",
      modelName: "llama3.2",
      chat: vi.fn(async () => ({
        model: "llama3.2",
        finishReason: "stop" as const,
        rawProviderName: "ollama",
        content: "I could not produce JSON today, sorry!",
      })),
    };
    const result = await runCompress({ ...opts(root), llmFactory: () => malformedLlm });

    // Audit finding 3: this used to write an EMPTY fact file plus a completed v3
    // watermark, which then suppressed the raw from compile as "fully covered".
    expect(result.files.find((f) => f.path === relPath)?.outcome).toBe("failed");
    const factRel = factFileRelPath(relPath, "session-a");
    expect(existsSync(join(root, ...factRel.split("/")))).toBe(false);
    expect((await cursor()).chunkCursor).toBeUndefined();
    expect((await cursor()).bytes).toBeUndefined();
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
