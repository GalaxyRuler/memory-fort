import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_COMPRESS_VERSION, compressSession } from "../../src/facts/compress.js";
import { runCompress } from "../../src/cli/commands/compress.js";
import { readCompressedFactFile } from "../../src/facts/store.js";
import type { LLMProvider, LLMRequest } from "../../src/llm/types.js";

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
      type: "project",
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
      type: "project",
      sessionId: "session-a",
      sourceRawPath: "raw/2026-05-31/session-a.md",
    });
    expect(vi.mocked(llm.chat).mock.calls[0]![0].messages.at(-1)!.content).not.toContain("sk-live-secret");
  });

  it("preserves extracted entities and relation triples from the existing compression call", async () => {
    const llm = fakeCompressionLLM([{
      title: "Memory System graph coverage",
      facts: ["Memory System added auto-linking for graph coverage."],
      narrative: "Memory System graph coverage now uses automatic links.",
      concepts: ["Memory System", "graph coverage"],
      files: ["src/capture/auto-link.ts"],
      importance: 8,
      type: "project",
      entities: ["Memory System", "Vitest"],
      relations: [
        { subject: "Memory System", predicate: "uses", object: "Vitest" },
        { subject: "Memory System", predicate: "tested-with", object: "Vitest" },
      ],
    }]);

    const facts = await compressSession({
      rawText: await readFile(join(tmp, "raw", "2026-05-31", "session-a.md"), "utf-8"),
      rawRelPath: "raw/2026-05-31/session-a.md",
      sessionId: "session-a",
      observedAt: "2026-05-31T00:00:00.000Z",
      llm,
    });

    expect(facts[0]).toMatchObject({
      entities: ["Memory System", "Vitest"],
      relations: [
        { subject: "Memory System", predicate: "uses", object: "Vitest" },
        { subject: "Memory System", predicate: "tested-with", object: "Vitest" },
      ],
    });
    const systemPrompt = vi.mocked(llm.chat).mock.calls[0]![0].messages[0]!.content;
    expect(systemPrompt).toContain("entities");
    expect(systemPrompt).toContain("relations");
  });

  it("loads old and new fact files with optional entities and relations", () => {
    const oldFacts = readCompressedFactFile(JSON.stringify({
      facts: [{
        ...factBundle("Old fact without relations", "fact"),
        sessionId: "session-a",
        sourceRawPath: "raw/2026-05-31/session-a.md",
        observedAt: "2026-05-31T00:00:00.000Z",
        compressedAt: "2026-05-31T12:00:00.000Z",
      }],
    }));
    const newFacts = readCompressedFactFile(JSON.stringify({
      facts: [{
        ...factBundle("New fact with relations", "fact"),
        entities: ["Memory System"],
        relations: [{ subject: "Memory System", predicate: "uses", object: "Vitest" }],
        sessionId: "session-a",
        sourceRawPath: "raw/2026-05-31/session-a.md",
        observedAt: "2026-05-31T00:00:00.000Z",
        compressedAt: "2026-05-31T12:00:00.000Z",
      }],
    }));

    expect(oldFacts[0]?.entities).toBeUndefined();
    expect(oldFacts[0]?.relations).toBeUndefined();
    expect(newFacts[0]?.entities).toEqual(["Memory System"]);
    expect(newFacts[0]?.relations).toEqual([
      { subject: "Memory System", predicate: "uses", object: "Vitest" },
    ]);
  });

  it("sends a full below-threshold session instead of the old 4KB head slice", async () => {
    const tailDecision = "TAIL_DECISION: keep the final compressor decision.";
    const rawText = [
      "session: session-a",
      "## [00:00:00] Prompt",
      "Opening text.",
      "A".repeat(5_000),
      tailDecision,
    ].join("\n");
    const llm = promptAwareCompressionLLM((request) => {
      const prompt = request.messages.at(-1)?.content ?? "";
      return [{
        title: "Tail compressor decision",
        facts: [prompt.includes(tailDecision) ? tailDecision : "tail was missing"],
        narrative: "The tail compressor decision was retained.",
        concepts: ["Memory System"],
        files: [],
        importance: 8,
        type: "decision",
      }];
    });

    const facts = await compressSession({
      rawText,
      rawRelPath: "raw/2026-05-31/session-a.md",
      sessionId: "session-a",
      observedAt: "2026-05-31T00:00:00.000Z",
      llm,
    });

    expect(facts[0]?.facts.join("\n")).toContain(tailDecision);
    expect(vi.mocked(llm.chat).mock.calls[0]![0].messages.at(-1)!.content).toContain(tailDecision);
  });

  it("reaches late-session procedures and decisions through chunked compression and writes them to fact bytes", async () => {
    const rawRelPath = "raw/2026-05-31/codex-019e7f47-78c5-7cd1-9e07-f75bee00a752.md";
    await writeFileAt(rawRelPath, largeSession([
      "Opening WebView2 initialization notes.",
      "Test-Driven Development procedure recovered near the middle of the session.",
      "Systematic Debugging Process procedure recovered late in the session.",
      "Homelab Runner Integration decision recovered at the end of the session.",
    ], 14_000).replace("session: session-a", "session: codex-019e7f47-78c5-7cd1-9e07-f75bee00a752"));
    const llm = promptAwareCompressionLLM((request) => {
      const prompt = request.messages.at(-1)?.content ?? "";
      const facts: Array<Record<string, unknown>> = [];
      if (prompt.includes("Test-Driven Development")) {
        facts.push(factBundle("Test-Driven Development", "procedure"));
      }
      if (prompt.includes("Systematic Debugging")) {
        facts.push(factBundle("Systematic Debugging Process", "procedure"));
      }
      if (prompt.includes("Homelab Runner")) {
        facts.push(factBundle("Homelab Runner Integration", "decision"));
      }
      if (facts.length === 0) facts.push(factBundle("Opening WebView2 initialization", "fact"));
      return facts;
    });

    const result = await runCompress({
      vaultRoot: tmp,
      apply: true,
      configLoader: async () => ({
        llm: { provider: "ollama", model: "llama3.2" },
        compress: { chunk_threshold_bytes: 8_000, max_chunks: 8 },
      }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:00.000Z"),
      logger: () => undefined,
    });

    expect(result.summary.compressed).toBe(2);
    const factPath = result.files.find((file) => file.path === rawRelPath)?.factPath;
    expect(factPath).toBeDefined();
    const factBytes = await readFile(join(tmp, ...factPath!.split("/")), "utf-8");
    expect(factBytes).toContain("Test-Driven Development");
    expect(factBytes).toContain("Systematic Debugging");
    expect(factBytes).toContain("Homelab Runner");
  });

  it("samples a bounded number of chunks while recording and logging skipped coverage", async () => {
    await writeFileAt("raw/2026-05-31/session-a.md", largeSession([
      "FIRST_CHUNK_MARKER",
      "interior marker one",
      "interior marker two",
      "interior marker three",
      "interior marker four",
      "LAST_CHUNK_MARKER",
    ], 7_000));
    const logs: string[] = [];
    const llm = promptAwareCompressionLLM((request) => {
      const prompt = request.messages.at(-1)?.content ?? "";
      if (prompt.includes("FIRST_CHUNK_MARKER")) return [factBundle("First chunk marker", "fact")];
      if (prompt.includes("LAST_CHUNK_MARKER")) return [factBundle("Last chunk marker", "fact")];
      return [factBundle("Sampled interior marker", "fact")];
    });

    const result = await runCompress({
      vaultRoot: tmp,
      apply: true,
      configLoader: async () => ({
        llm: { provider: "ollama", model: "llama3.2" },
        compress: { chunk_threshold_bytes: 1_500, max_chunks: 4 },
      }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:00.000Z"),
      logger: (line) => logs.push(line),
    });

    expect(llm.chat).toHaveBeenCalledTimes(4);
    expect(result.files[0]).toMatchObject({ sampledChunks: 4 });
    expect(result.files[0]?.totalChunks).toBeGreaterThan(4);
    expect(logs.join("\n")).toContain("sampled 4/");
    const factFile = JSON.parse(await readFile(join(tmp, "facts", "2026-05-31", "session-a.json"), "utf-8"));
    expect(factFile.sampledChunks).toBe(4);
    expect(factFile.totalChunks).toBeGreaterThan(4);
    const prompts = vi.mocked(llm.chat).mock.calls.map((call) => call[0].messages.at(-1)!.content).join("\n");
    expect(prompts).toContain("FIRST_CHUNK_MARKER");
    expect(prompts).toContain("LAST_CHUNK_MARKER");
  });

  it("redacts secrets found in deep chunks before sending them to the provider", async () => {
    const deepSecret = "DEEP_SECRET_TOKEN=sk-deep-secret-token";
    await writeFileAt("raw/2026-05-31/session-a.md", [
      "session: session-a",
      "## [00:00:00] Prompt",
      "A".repeat(60_000),
      "## [00:30:00] Tool",
      deepSecret,
      "DEEP_SECRET_MARKER",
    ].join("\n"));
    const llm = promptAwareCompressionLLM(() => [factBundle("Deep secret marker", "fact")]);

    await runCompress({
      vaultRoot: tmp,
      apply: true,
      configLoader: async () => ({
        llm: { provider: "ollama", model: "llama3.2" },
        compress: { chunk_threshold_bytes: 48_000, max_chunks: 8 },
      }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:00.000Z"),
    });

    const prompts = vi.mocked(llm.chat).mock.calls.map((call) => call[0].messages.at(-1)!.content).join("\n");
    expect(prompts).not.toContain("sk-deep-secret-token");
    expect(prompts).toContain("DEEP_SECRET_TOKEN=[REDACTED]");
    expect(prompts).toContain("DEEP_SECRET_MARKER");
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
    expect(state.compressed["raw/2026-05-31/session-a.md"].compressVersion).toBe(CURRENT_COMPRESS_VERSION);
  });

  it("re-compresses old-version watermarks and skips only current-version matches", async () => {
    const rawPath = join(tmp, "raw", "2026-05-31", "session-a.md");
    const info = await stat(rawPath);
    await writeFileAt("state/compile-state.json", JSON.stringify({
      compressed: {
        "raw/2026-05-31/session-a.md": {
          bytes: info.size,
          lastObservationAt: "2026-05-31T00:00:00.000Z",
          compressVersion: 1,
        },
      },
    }, null, 2));
    const llm = fakeCompressionLLM([factBundle("Recompressed current version", "fact")]);

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

    expect(first.summary).toMatchObject({ compressed: 1, skipped: 0 });
    expect(second.summary).toMatchObject({ compressed: 0, skipped: 1 });
    expect(llm.chat).toHaveBeenCalledTimes(1);
    const state = JSON.parse(await readFile(join(tmp, "state", "compile-state.json"), "utf-8"));
    expect(state.compressed["raw/2026-05-31/session-a.md"].compressVersion).toBe(CURRENT_COMPRESS_VERSION);
  });

  it("continues apply mode after one raw session fails and reports the failed session", async () => {
    await writeFileAt("raw/2026-05-31/session-b.md", [
      "---",
      "type: raw-session",
      "title: Session B",
      "created: 2026-05-31",
      "updated: 2026-05-31",
      "session: session-b",
      "---",
      "",
      "Memory System added a safe dashboard status contract.",
    ].join("\n"));
    const llm: LLMProvider = {
      providerName: "ollama",
      modelName: "llama3.2",
      chat: vi.fn(async (request) => {
        const prompt = request.messages.at(-1)?.content ?? "";
        if (prompt.includes("session-a.md")) {
          throw new Error("provider timeout");
        }
        return {
          model: "llama3.2",
          finishReason: "stop",
          rawProviderName: "ollama",
          tokensUsed: { prompt: 20, completion: 8, total: 28 },
          content: [
            "```json",
            JSON.stringify({
              facts: [{
                title: "Memory System dashboard status contract",
                facts: ["Memory System added a safe dashboard status contract."],
                narrative: "Dashboard status responses have a safe contract.",
                concepts: ["Memory System"],
                files: [],
                importance: 7,
              }],
            }),
            "```",
          ].join("\n"),
        };
      }),
    };

    const result = await runCompress({
      vaultRoot: tmp,
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:00.000Z"),
    });

    expect(result.summary).toMatchObject({ compressed: 1, failed: 1, factsWritten: 1 });
    expect(result.files).toEqual([
      expect.objectContaining({
        path: "raw/2026-05-31/session-a.md",
        outcome: "failed",
        reason: "provider timeout",
      }),
      expect.objectContaining({
        path: "raw/2026-05-31/session-b.md",
        outcome: "compressed",
        facts: 1,
        factPath: "facts/2026-05-31/session-b.json",
      }),
    ]);
    expect(existsSync(join(tmp, "facts", "2026-05-31", "session-a.json"))).toBe(false);
    expect(existsSync(join(tmp, "facts", "2026-05-31", "session-b.json"))).toBe(true);
    const state = JSON.parse(await readFile(join(tmp, "state", "compile-state.json"), "utf-8"));
    expect(state.compressed["raw/2026-05-31/session-a.md"]).toBeUndefined();
    expect(state.compressed["raw/2026-05-31/session-b.md"].bytes).toBeGreaterThan(0);
  });

  async function writeFileAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function factBundle(title: string, type: string): Record<string, unknown> {
  return {
    title,
    facts: [`${title} was recovered from the session.`],
    narrative: `${title} was recovered from the session.`,
    concepts: [title],
    files: [],
    importance: 8,
    type,
  };
}

function largeSession(markers: string[], spacerLength: number): string {
  return [
    "session: session-a",
    ...markers.map((marker, index) => [
      `## [00:${String(index).padStart(2, "0")}:00] Observation`,
      marker,
      "A".repeat(spacerLength),
    ].join("\n")),
  ].join("\n");
}

function fakeCompressionLLM(facts: Array<Record<string, unknown>>): LLMProvider {
  return promptAwareCompressionLLM(() => facts);
}

function promptAwareCompressionLLM(factory: (request: LLMRequest) => Array<Record<string, unknown>>): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async (request) => ({
      model: "llama3.2",
      finishReason: "stop",
      rawProviderName: "ollama",
      tokensUsed: { prompt: 20, completion: 8, total: 28 },
      content: [
        "```json",
        JSON.stringify({ facts: factory(request) }),
        "```",
      ].join("\n"),
    })),
  };
}
