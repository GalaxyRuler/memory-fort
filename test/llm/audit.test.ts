import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatWithAudit,
  hashPrompt,
  hashResponse,
  isDebugLogEnabled,
  readLLMAuditSummary,
  writeLLMAuditEntry,
} from "../../src/llm/audit.js";
import type { LLMProvider } from "../../src/llm/types.js";

describe("LLM audit log", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "llm-audit-"));
    await mkdir(join(tmp, "wiki"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("hashes prompts and responses deterministically", () => {
    expect(hashPrompt([{ role: "user", content: "secret prompt" }]))
      .toMatch(/^[a-f0-9]{16}$/);
    expect(hashPrompt([{ role: "user", content: "secret prompt" }]))
      .toBe(hashPrompt([{ role: "user", content: "secret prompt" }]));
    expect(hashResponse("secret response")).toMatch(/^[a-f0-9]{16}$/);
  });

  it("enables plaintext debug logging only for MEMORY_LLM_DEBUG_LOG=1", () => {
    expect(isDebugLogEnabled({ MEMORY_LLM_DEBUG_LOG: "1" })).toBe(true);
    expect(isDebugLogEnabled({ MEMORY_LLM_DEBUG_LOG: "true" })).toBe(false);
    expect(isDebugLogEnabled({ MEMORY_LLM_DEBUG_LOG: "yes" })).toBe(false);
    expect(isDebugLogEnabled({ MEMORY_LLM_DEBUG_LOG: "" })).toBe(false);
    expect(isDebugLogEnabled({})).toBe(false);
  });

  it("writes markdown rows without plaintext prompt or response", async () => {
    await writeLLMAuditEntry(tmp, {
      ts: "2026-05-27T22:14:03.000Z",
      consumer: "auto-thread-propose",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      promptHash: hashPrompt([{ role: "user", content: "secret prompt" }]),
      responseHash: hashResponse("secret response"),
      tokensIn: 12,
      tokensOut: 4,
      durationMs: 100,
      estimatedCostUSD: 0.00012,
      finishReason: "stop",
      referencesStripped: 3,
      strippedSamples: ["wiki/decisions/invented.md"],
      prosePathLeaks: 2,
      prosePathLeakSamples: ["wiki/projects/agentmemory.md"],
    });

    const content = await readFile(
      join(tmp, "wiki", ".audit", "llm-2026-05-27.md"),
      "utf-8",
    );
    expect(content).toContain("# LLM audit log 2026-05-27");
    expect(content).toContain("auto-thread-propose");
    expect(content).toContain("| references_stripped |");
    expect(content).toContain("| prose_path_leaks |");
    expect(content).toContain("wiki/decisions/invented.md");
    expect(content).toContain("wiki/projects/agentmemory.md");
    expect(content).not.toContain("secret prompt");
    expect(content).not.toContain("secret response");
  });

  it("chatWithAudit writes success entries and audit-summary reads them", async () => {
    vi.setSystemTime(new Date("2026-05-27T22:14:03.000Z"));
    const llm: LLMProvider = {
      providerName: "ollama",
      modelName: "llama3.2",
      chat: vi.fn(async () => ({
        content: "pong",
        model: "llama3.2",
        tokensUsed: { prompt: 2, completion: 1, total: 3 },
        finishReason: "stop",
        rawProviderName: "ollama",
      })),
    };

    await chatWithAudit({
      llm,
      vaultRoot: tmp,
      consumer: "provider-test",
      request: { messages: [{ role: "user", content: "secret prompt" }] },
      env: {},
    });

    const summary = await readLLMAuditSummary(tmp, {
      days: 7,
      now: new Date("2026-05-28T00:00:00.000Z"),
    });
    expect(summary.totalCalls).toBe(1);
    expect(summary.byConsumer).toEqual([{
      consumer: "provider-test",
      calls: 1,
      costUsd: 0,
      unknownCostCalls: 0,
      referencesStripped: 0,
      prosePathLeaks: 0,
    }]);
    vi.useRealTimers();
  });

  it("chatWithAudit writes estimated cost for known priced models", async () => {
    vi.setSystemTime(new Date("2026-05-27T22:14:03.000Z"));
    const llm: LLMProvider = {
      providerName: "openrouter",
      modelName: "openai/gpt-4o-mini",
      chat: vi.fn(async () => ({
        content: "pong",
        model: "openai/gpt-4o-mini",
        tokensUsed: { prompt: 1_000_000, completion: 1_000_000, total: 2_000_000 },
        finishReason: "stop",
        rawProviderName: "openrouter",
      })),
    };

    await chatWithAudit({
      llm,
      vaultRoot: tmp,
      consumer: "provider-test",
      request: { messages: [{ role: "user", content: "secret prompt" }] },
      env: {},
    });

    const audit = await readFile(join(tmp, "wiki", ".audit", "llm-2026-05-27.md"), "utf-8");
    expect(audit).toContain("| 1000000 | 1000000 |");
    expect(audit).toContain("| 0.75 |");
    const summary = await readLLMAuditSummary(tmp, {
      days: 7,
      now: new Date("2026-05-28T00:00:00.000Z"),
    });
    expect(summary.totalCostUsd).toBe(0.75);
    expect(summary.unknownCostCalls).toBe(0);
    vi.useRealTimers();
  });

  it("chatWithAudit preserves unknown cost when pricing is unavailable", async () => {
    vi.setSystemTime(new Date("2026-05-27T22:14:03.000Z"));
    const llm: LLMProvider = {
      providerName: "openrouter",
      modelName: "unknown/model",
      chat: vi.fn(async () => ({
        content: "pong",
        model: "unknown/model",
        tokensUsed: { prompt: 10, completion: 5, total: 15 },
        finishReason: "stop",
        rawProviderName: "openrouter",
      })),
    };

    await chatWithAudit({
      llm,
      vaultRoot: tmp,
      consumer: "provider-test",
      request: { messages: [{ role: "user", content: "secret prompt" }] },
      env: {},
    });

    const summary = await readLLMAuditSummary(tmp, {
      days: 7,
      now: new Date("2026-05-28T00:00:00.000Z"),
    });
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.unknownCostCalls).toBe(1);
    expect(summary.byConsumer[0]).toMatchObject({ unknownCostCalls: 1 });
    expect(summary.byProviderModel[0]).toMatchObject({ unknownCostCalls: 1 });
    vi.useRealTimers();
  });

  it("does not write plaintext debug logs when the debug env var is unset or not exactly 1", async () => {
    vi.setSystemTime(new Date("2026-05-27T22:14:03.000Z"));
    const llm = fakeLLM("pong");

    for (const env of [{}, { MEMORY_LLM_DEBUG_LOG: "true" }, { MEMORY_LLM_DEBUG_LOG: "yes" }, { MEMORY_LLM_DEBUG_LOG: "" }]) {
      await chatWithAudit({
        llm,
        vaultRoot: tmp,
        consumer: "provider-test",
        request: { messages: [{ role: "user", content: "plaintext prompt" }] },
        env,
      });
    }

    expect(existsSync(join(tmp, "wiki", ".audit", "llm-debug-2026-05-27.md"))).toBe(false);
    vi.useRealTimers();
  });

  it("writes plaintext prompt and response to a debug log when explicitly enabled", async () => {
    vi.setSystemTime(new Date("2026-05-27T22:14:03.000Z"));

    await chatWithAudit({
      llm: fakeLLM("plaintext response"),
      vaultRoot: tmp,
      consumer: "provider-test",
      request: { messages: [{ role: "user", content: "plaintext prompt" }] },
      env: { MEMORY_LLM_DEBUG_LOG: "1" },
    });

    const hashed = await readFile(join(tmp, "wiki", ".audit", "llm-2026-05-27.md"), "utf-8");
    const debug = await readFile(join(tmp, "wiki", ".audit", "llm-debug-2026-05-27.md"), "utf-8");
    expect(hashed).not.toContain("plaintext prompt");
    expect(hashed).not.toContain("plaintext response");
    expect(debug).toContain("# LLM debug log");
    expect(debug).toContain("contains plaintext prompts and responses");
    expect(debug).toContain("## 2026-05-27T22:14:03.000Z - provider-test");
    expect(debug).toContain('"content": "plaintext prompt"');
    expect(debug).toContain("plaintext response");
    expect(debug).toContain("model: llama3.2");
    expect(debug).toContain("tokens: 2/1");
    vi.useRealTimers();
  });
});

function fakeLLM(content: string): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async () => ({
      content,
      model: "llama3.2",
      tokensUsed: { prompt: 2, completion: 1, total: 3 },
      finishReason: "stop",
      rawProviderName: "ollama",
    })),
  };
}
