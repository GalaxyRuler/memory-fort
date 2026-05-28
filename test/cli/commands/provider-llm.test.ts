import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatAuditSummaryResult,
  formatListLLMsResult,
  formatTestLLMResult,
  runAuditSummary,
  runListLLMs,
  runTestLLM,
} from "../../../src/cli/commands/provider.js";
import { hashPrompt, hashResponse, writeLLMAuditEntry } from "../../../src/llm/audit.js";

describe("provider LLM commands", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "provider-llm-"));
    await mkdir(join(tmp, "wiki"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("lists LLM providers with active config", async () => {
    const result = await runListLLMs({
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      env: { OLLAMA_HOST: "http://localhost:11434" },
    });

    expect(formatListLLMsResult(result)).toContain("ollama");
    expect(formatListLLMsResult(result)).toContain("[active, model=llama3.2");
    expect(formatListLLMsResult(result)).toContain("OPENROUTER_API_KEY");
  });

  it("tests the active LLM and reports latency", async () => {
    const result = await runTestLLM({
      memoryRoot: tmp,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      env: {},
      llmFactory: () => ({
        providerName: "ollama",
        modelName: "llama3.2",
        chat: vi.fn(async () => ({
          content: "pong",
          model: "llama3.2",
          finishReason: "stop",
          rawProviderName: "ollama",
          tokensUsed: { prompt: 3, completion: 1, total: 4 },
        })),
      }),
      nowMs: (() => {
        const values = [100, 133];
        return () => values.shift() ?? 133;
      })(),
    });

    expect(result.exitCode).toBe(0);
    expect(formatTestLLMResult(result)).toContain("Provider: ollama");
    expect(formatTestLLMResult(result)).toContain("Latency: 33ms");
    expect(formatTestLLMResult(result)).toContain("Finish: stop");
  });

  it("summarizes audit logs", async () => {
    const result = await runAuditSummary({
      memoryRoot: tmp,
      days: 7,
      now: new Date("2026-05-27T23:00:00.000Z"),
      auditWriter: async () => {
        await writeLLMAuditEntry(tmp, auditEntry("auto-thread-propose", 3));
        await writeLLMAuditEntry(tmp, auditEntry("auto-thread-propose", 1));
        await writeLLMAuditEntry(tmp, auditEntry("auto-procedural-extract", 2));
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.totalCalls).toBe(3);
    expect(formatAuditSummaryResult(result)).toContain("Total calls: 3");
    expect(formatAuditSummaryResult(result)).toContain("auto-thread-propose: 2 calls");
    expect(formatAuditSummaryResult(result)).toContain("References stripped: 4 (avg 2.0 per call)");
    expect(formatAuditSummaryResult(result)).toContain("auto-procedural-extract: 1 call");
    expect(formatAuditSummaryResult(result)).toContain("References stripped: 2 (avg 2.0 per call)");
  });
});

function auditEntry(consumer: string, referencesStripped: number) {
  return {
    ts: "2026-05-27T22:14:03.000Z",
    consumer,
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    promptHash: hashPrompt([{ role: "user" as const, content: consumer }]),
    responseHash: hashResponse(String(referencesStripped)),
    tokensIn: 10,
    tokensOut: 5,
    durationMs: 12,
    costUsd: 0.001,
    finishReason: "stop" as const,
    referencesStripped,
  };
}
