import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_COMPRESS_VERSION, compressSession, mergeCompressedFacts } from "../../src/facts/compress.js";
import type { CompressedFact } from "../../src/facts/store.js";
import { runCompress } from "../../src/cli/commands/compress.js";
import { readCompileStateFile, writeCompileStateFile } from "../../src/compile/state.js";
import { loadCompressedFacts, readCompressedFactFile } from "../../src/facts/store.js";
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

  it("loads only live fact files and keeps retained archive/system facts out of compile inputs", async () => {
    const factFile = (title: string) => JSON.stringify({
      facts: [{
        title,
        facts: [title],
        narrative: title,
        concepts: ["Memory System"],
        files: [],
        importance: 5,
        sessionId: "session-a",
        sourceRawPath: "raw/2026-05-31/session-a.md",
        observedAt: "2026-05-31T00:00:00.000Z",
        compressedAt: "2026-05-31T01:00:00.000Z",
      }],
    });
    await writeFileAt("facts/2026-05-31/live.json", factFile("Live fact"));
    await writeFileAt("facts/Archive/retained.json", factFile("Archive fact"));
    await writeFileAt("facts/_archive/retained.json", factFile("Maintenance archive fact"));
    await writeFileAt("facts/.audit/retained.json", factFile("System fact"));

    await expect(loadCompressedFacts(tmp)).resolves.toMatchObject([{ title: "Live fact" }]);
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

  it("reaches late-session content across resumed passes without losing earlier windows' facts", async () => {
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
      if (prompt.includes("Opening WebView2")) facts.push(factBundle("Opening WebView2 initialization", "fact"));
      if (prompt.includes("Test-Driven Development")) facts.push(factBundle("Test-Driven Development", "procedure"));
      if (prompt.includes("Systematic Debugging")) facts.push(factBundle("Systematic Debugging Process", "procedure"));
      if (prompt.includes("Homelab Runner")) facts.push(factBundle("Homelab Runner Integration", "decision"));
      return facts;
    });

    const opts = {
      vaultRoot: tmp,
      apply: true,
      configLoader: async () => ({
        llm: { provider: "ollama", model: "llama3.2" },
        // Small windows so the late content only appears after several passes.
        compress: { chunk_threshold_bytes: 8_000, max_chunks: 2 },
      }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:00.000Z"),
      logger: () => undefined,
    };

    // Drain to completion across passes; the file must converge and merge — every
    // window's facts survive in the single fact file (conservation invariant).
    let factPath: string | undefined;
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await runCompress(opts);
      const file = result.files.find((f) => f.path === rawRelPath);
      factPath ??= file?.factPath;
      if (file?.reason === "already compressed") break;
    }
    expect(factPath).toBeDefined();
    const factBytes = await readFile(join(tmp, ...factPath!.split("/")), "utf-8");
    expect(factBytes).toContain("Test-Driven Development");
    expect(factBytes).toContain("Systematic Debugging");
    expect(factBytes).toContain("Homelab Runner");
  });

  it("processes a bounded contiguous first window and logs the resumable remainder", async () => {
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
      if (prompt.includes("interior marker")) return [factBundle("Interior marker", "fact")];
      return [];
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

    // The first pass covers the CONTIGUOUS front window [1..4], not a spread sample.
    expect(compressionCallCount(llm)).toBe(4);
    expect(result.files[0]?.totalChunks).toBeGreaterThan(4);
    expect(logs.join("\n")).toContain("processing chunks 1-4");
    const prompts = compressionPrompts(llm).join("\n");
    // Front window includes the first chunk; the last chunk is beyond it and
    // resumes on a later pass (proven by the multi-pass convergence test).
    expect(prompts).toContain("FIRST_CHUNK_MARKER");
    expect(prompts).not.toContain("LAST_CHUNK_MARKER");
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
    const llm = promptAwareCompressionLLM((request) => {
      const prompt = request.messages.at(-1)?.content ?? "";
      return prompt.includes("DEEP_SECRET_MARKER") ? [factBundle("Deep secret marker", "fact")] : [];
    });

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

    const prompts = compressionPrompts(llm).join("\n");
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
    expect(compressionCallCount(llm)).toBe(1);
    expect(existsSync(join(tmp, "facts", "2026-05-31", "session-a.json"))).toBe(true);
    const state = await readCompileStateFile(tmp);
    expect(state.compressed?.["raw/2026-05-31/session-a.md"]?.bytes).toBeGreaterThan(0);
    expect(state.compressed?.["raw/2026-05-31/session-a.md"]?.compressVersion).toBe(CURRENT_COMPRESS_VERSION);
  });

  it("re-compresses old-version watermarks and skips only current-version matches", async () => {
    const rawPath = join(tmp, "raw", "2026-05-31", "session-a.md");
    const info = await stat(rawPath);
    await writeCompileStateFile(tmp, {
      compressed: {
        "raw/2026-05-31/session-a.md": {
          bytes: info.size,
          lastObservationAt: "2026-05-31T00:00:00.000Z",
          compressVersion: 1,
        },
      },
    });
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
    expect(compressionCallCount(llm)).toBe(1);
    const state = await readCompileStateFile(tmp);
    expect(state.compressed?.["raw/2026-05-31/session-a.md"]?.compressVersion).toBe(CURRENT_COMPRESS_VERSION);
  });

  it("does not carry a same-content v3 artifact into the v4 fact file", async () => {
    const rawRelPath = "raw/2026-05-31/session-a.md";
    const rawPath = join(tmp, "raw", "2026-05-31", "session-a.md");
    const info = await stat(rawPath);
    await writeFileAt("facts/2026-05-31/session-a.json", `${JSON.stringify({
      version: 1,
      sourceRawPath: rawRelPath,
      sessionId: "session-a",
      observedAt: "2026-05-31T00:00:00.000Z",
      compressedAt: "2026-05-31T01:00:00.000Z",
      facts: [{
        title: "Unverified v3 Mars relay",
        facts: ["Memory System deployed an unverified Mars relay."],
        narrative: "Memory System deployed an unverified Mars relay.",
        concepts: ["Memory System"],
        files: [],
        importance: 9,
        type: "project",
        sessionId: "session-a",
        sourceRawPath: rawRelPath,
        observedAt: "2026-05-31T00:00:00.000Z",
        compressedAt: "2026-05-31T01:00:00.000Z",
      }],
    }, null, 2)}\n`);
    await writeCompileStateFile(tmp, {
      compressed: {
        [rawRelPath]: {
          bytes: info.size,
          lastObservationAt: "2026-05-31T00:00:00.000Z",
          compressVersion: CURRENT_COMPRESS_VERSION - 1,
        },
      },
    });
    const llm = fakeCompressionLLM([{
      title: "Fresh v4 retrieval fact",
      facts: ["Memory System shipped Phase 3 retrieval."],
      narrative: "Memory System shipped Phase 3 retrieval.",
      concepts: ["Memory System"],
      files: [],
      importance: 8,
      type: "project",
    }]);

    const result = await runCompress({
      vaultRoot: tmp,
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:00.000Z"),
    });

    expect(result.summary).toMatchObject({ compressed: 1, factsWritten: 1 });
    const facts = readCompressedFactFile(await readFile(join(tmp, "facts", "2026-05-31", "session-a.json"), "utf-8"));
    expect(facts.map((fact) => fact.title)).toEqual(["Fresh v4 retrieval fact"]);
    expect(facts.map((fact) => fact.title)).not.toContain("Unverified v3 Mars relay");
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
        if (request.jsonSchema?.name === "FaithfulnessOutput") {
          return {
            model: "llama3.2",
            finishReason: "stop" as const,
            rawProviderName: "ollama",
            tokensUsed: { prompt: 20, completion: 8, total: 28 },
            content: JSON.stringify({ unsupported_claims: [] }),
          };
        }
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
                evidence: "Memory System added a safe dashboard status contract.",
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
    const state = await readCompileStateFile(tmp);
    expect(state.compressed?.["raw/2026-05-31/session-a.md"]).toBeUndefined();
    expect(state.compressed?.["raw/2026-05-31/session-b.md"]?.bytes).toBeGreaterThan(0);
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
    chat: vi.fn(async (request) => {
      if (request.jsonSchema?.name === "FaithfulnessOutput") {
        return {
          model: "llama3.2",
          finishReason: "stop" as const,
          rawProviderName: "ollama",
          tokensUsed: { prompt: 20, completion: 8, total: 28 },
          content: JSON.stringify({ unsupported_claims: [] }),
        };
      }
      const prompt = request.messages.at(-1)?.content ?? "";
      const evidence = /Session text:\n```markdown\n([\s\S]*?)\n```/.exec(prompt)?.[1] ?? "session evidence unavailable";
      return {
        model: "llama3.2",
        finishReason: "stop" as const,
        rawProviderName: "ollama",
        tokensUsed: { prompt: 20, completion: 8, total: 28 },
        content: [
          "```json",
          JSON.stringify({ facts: factory(request).map((fact) => ({ ...fact, evidence: fact.evidence ?? evidence })) }),
          "```",
        ].join("\n"),
      };
    }),
  };
}

function compressionCallCount(llm: LLMProvider): number {
  return vi.mocked(llm.chat).mock.calls.filter(([request]) => request.jsonSchema?.name !== "FaithfulnessOutput").length;
}

function compressionPrompts(llm: LLMProvider): string[] {
  return vi.mocked(llm.chat).mock.calls
    .filter(([request]) => request.jsonSchema?.name !== "FaithfulnessOutput")
    .map(([request]) => request.messages.at(-1)?.content ?? "");
}

function truncatedCompressionLLM(reason: "length" | "filter" | "error" | "other" | "tool_calls"): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async () => ({
      model: "llama3.2",
      finishReason: reason,
      rawProviderName: "ollama",
      tokensUsed: { prompt: 20, completion: 8, total: 28 },
      content: [
        "```json",
        JSON.stringify({
          facts: [{
            title: "Partial",
            facts: ["a truncated fact"],
            narrative: "n",
            concepts: ["c"],
            files: [],
            importance: 5,
            type: "fact",
          }],
        }),
        "```",
      ].join("\n"),
    })),
  };
}

describe("mergeCompressedFacts dedupes non-Latin titles", () => {
  function fact(title: string): CompressedFact {
    return {
      title,
      facts: [title],
      narrative: title,
      concepts: ["c"],
      files: [],
      importance: 5,
      type: "fact",
      sessionId: "s",
      sourceRawPath: "raw/2026-07-17/x.md",
      observedAt: "2026-07-17T00:00:00.000Z",
      compressedAt: "2026-07-17T00:00:00.000Z",
    } as CompressedFact;
  }

  it("collapses identical Arabic titles instead of accumulating duplicates", () => {
    const merged = mergeCompressedFacts([fact("قرار المشروع"), fact("قرار المشروع"), fact("قرار المشروع")]);
    expect(merged).toHaveLength(1);
  });

  it("treats an omitted type and the literal 'fact' type as one identity (no double-count)", () => {
    const untyped = { ...fact("Same title"), type: undefined } as unknown as CompressedFact;
    const generic = { ...fact("Same title"), type: "fact" } as CompressedFact;
    expect(mergeCompressedFacts([untyped, generic])).toHaveLength(1);
  });

  it("keeps distinct substantive types separate even with identical titles", () => {
    const decision = { ...fact("Memory retention policy"), type: "decision" } as CompressedFact;
    const lesson = { ...fact("Memory retention policy"), type: "lesson" } as CompressedFact;
    expect(mergeCompressedFacts([decision, lesson])).toHaveLength(2);
  });
});

describe("compress rejects unusable fact members (semantic-invalid, not just truncated)", () => {
  function factsResponseLlm(content: string): LLMProvider {
    return {
      providerName: "ollama",
      modelName: "llama3.2",
      chat: vi.fn(async () => ({
        model: "llama3.2",
        finishReason: "stop" as const,
        rawProviderName: "ollama",
        content,
      })),
    };
  }

  it("throws when every fact member is empty ({\"facts\":[{}]}) instead of recording zero-fact coverage", async () => {
    await expect(
      compressSession({
        rawText: "## [10:00:00] Prompt\nhello\n",
        rawRelPath: "raw/2026-07-17/x.md",
        sessionId: "x",
        observedAt: "2026-07-17T00:00:00.000Z",
        llm: factsResponseLlm("```json\n" + JSON.stringify({ facts: [{}] }) + "\n```"),
      }),
    ).rejects.toThrow(/unusable/);
  });

  it("throws when a mix of valid and invalid members would silently drop the invalid one", async () => {
    const mixed = { facts: [
      { title: "Real", facts: ["a"], narrative: "n", concepts: ["c"], files: [], importance: 5, type: "fact" },
      {},
    ] };
    await expect(
      compressSession({
        rawText: "## [10:00:00] Prompt\nhello\n",
        rawRelPath: "raw/2026-07-17/x.md",
        sessionId: "x",
        observedAt: "2026-07-17T00:00:00.000Z",
        llm: factsResponseLlm("```json\n" + JSON.stringify(mixed) + "\n```"),
      }),
    ).rejects.toThrow(/unusable/);
  });

  it("rejects an empty extraction for a substantive chunk instead of marking it covered", async () => {
    await expect(compressSession({
      rawText: "## [10:00:00] Observation\nMemory System shipped Phase 3 retrieval.\n",
      rawRelPath: "raw/2026-07-17/x.md",
      sessionId: "x",
      observedAt: "2026-07-17T00:00:00.000Z",
      llm: factsResponseLlm("```json\n" + JSON.stringify({ facts: [] }) + "\n```"),
    })).rejects.toThrow(/empty fact bundle/);
  });
});

describe("compress truncation gate", () => {
  it.each(["length", "filter"] as const)(
    "throws instead of returning facts when finishReason=%s",
    async (reason) => {
      await expect(
        compressSession({
          rawText: "## [10:00:00] Prompt\nhello truncated world\n",
          rawRelPath: "raw/2026-07-17/claude-code-x.md",
          sessionId: "x",
          observedAt: "2026-07-17T00:00:00.000Z",
          llm: truncatedCompressionLLM(reason),
        }),
      ).rejects.toThrow(/truncated/);
    },
  );

  it.each(["error", "other", "tool_calls"] as const)(
    "rejects non-stop LLM responses as unverifiable when finishReason=%s",
    async (reason) => {
      await expect(
        compressSession({
          rawText: "## [10:00:00] Prompt\nhello unverified world\n",
          rawRelPath: "raw/2026-07-17/claude-code-x.md",
          sessionId: "x",
          observedAt: "2026-07-17T00:00:00.000Z",
          llm: truncatedCompressionLLM(reason),
        }),
      ).rejects.toThrow(/unverifiable/);
    },
  );

  it("runCompress leaves no fact file and no watermark when the response is unverifiable", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-compress-trunc-"));
    try {
      const relPath = "raw/2026-07-17/session-trunc.md";
      await mkdir(join(root, "raw", "2026-07-17"), { recursive: true });
      await writeFile(join(root, relPath), "## [10:00:00] Prompt\nhello truncated world\n", "utf-8");

      const result = await runCompress({
        vaultRoot: root,
        apply: true,
        configLoader: async () => ({}),
        llmFactory: () => truncatedCompressionLLM("error"),
      });

      expect(result.files.find((f) => f.path === relPath)?.outcome).toBe("failed");
      // Conservation: neither the fact artifact nor the watermark may exist.
      expect(existsSync(join(root, "facts", "2026-07-17", "session-trunc.json"))).toBe(false);
      const state = await readCompileStateFile(root);
      const compressed = (state as { compressed?: Record<string, unknown> }).compressed ?? {};
      expect(compressed[relPath]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
