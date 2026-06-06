import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatAuditSummaryResult,
  formatAuditRotateResult,
  formatListLLMsResult,
  formatTestLLMResult,
  runAuditRotate,
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
        await writeLLMAuditEntry(tmp, auditEntry("auto-thread-propose", 3, 2));
        await writeLLMAuditEntry(tmp, auditEntry("auto-thread-propose", 1, 0));
        await writeLLMAuditEntry(tmp, auditEntry("auto-procedural-extract", 2, 1));
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.totalCalls).toBe(3);
    expect(formatAuditSummaryResult(result)).toContain("Total calls: 3");
    expect(formatAuditSummaryResult(result)).toContain("auto-thread-propose: 2 calls");
    expect(formatAuditSummaryResult(result)).toContain("References stripped: 4 (avg 2.0 per call)");
    expect(formatAuditSummaryResult(result)).toContain("Prose path leaks: 2 (avg 1.0 per call)");
    expect(formatAuditSummaryResult(result)).toContain("auto-procedural-extract: 1 call");
    expect(formatAuditSummaryResult(result)).toContain("References stripped: 2 (avg 2.0 per call)");
    expect(formatAuditSummaryResult(result)).toContain("Prose path leaks: 1 (avg 1.0 per call)");
  });

  it("renders unknown audit costs distinctly from zero-cost calls", async () => {
    const result = await runAuditSummary({
      memoryRoot: tmp,
      days: 7,
      now: new Date("2026-05-27T23:00:00.000Z"),
      auditWriter: async () => {
        await writeLLMAuditEntry(tmp, {
          ...auditEntry("provider-test", 0, 0),
          costUsd: null,
          model: "unknown/model",
        });
      },
    });

    expect(result.unknownCostCalls).toBe(1);
    expect(formatAuditSummaryResult(result)).toContain("Total cost: $0.0000 (1 unknown)");
    expect(formatAuditSummaryResult(result)).toContain("provider-test: 1 call, $0.0000 (1 unknown)");
    expect(formatAuditSummaryResult(result)).toContain("openrouter/unknown/model: 1 call, tokens 10/5, $0.0000 (1 unknown)");
  });

  it("plans and applies audit log rotation by archiving old log families", async () => {
    await mkdir(join(tmp, "wiki", ".audit"), { recursive: true });
    await writeFile(join(tmp, "wiki", ".audit", "llm-2026-04-01.md"), "old llm");
    await writeFile(join(tmp, "wiki", ".audit", "thread-propose-2026-04-01.md"), "old thread");
    await writeFile(join(tmp, "wiki", ".audit", "compile-2026-04-01T10-00-00.md"), "old compile");
    await writeFile(join(tmp, "wiki", ".audit", "llm-2026-05-20.md"), "fresh llm");

    const plan = await runAuditRotate({
      memoryRoot: tmp,
      mode: "plan",
      keepDays: 30,
      now: new Date("2026-05-29T00:00:00.000Z"),
    });

    expect(plan.applied).toBe(false);
    expect(plan.candidates.map((candidate) => candidate.path).sort()).toEqual([
      "wiki/.audit/compile-2026-04-01T10-00-00.md",
      "wiki/.audit/llm-2026-04-01.md",
      "wiki/.audit/thread-propose-2026-04-01.md",
    ]);
    expect(formatAuditRotateResult(plan)).toContain("Mode: plan");
    expect(existsSync(join(tmp, "wiki", ".audit", "llm-2026-04-01.md"))).toBe(true);

    const applied = await runAuditRotate({
      memoryRoot: tmp,
      mode: "apply",
      keepDays: 30,
      now: new Date("2026-05-29T00:00:00.000Z"),
    });

    expect(applied.applied).toBe(true);
    expect(applied.archived).toHaveLength(3);
    expect(existsSync(join(tmp, "wiki", ".audit", "llm-2026-04-01.md"))).toBe(false);
    expect(existsSync(join(tmp, "wiki", ".audit", "archive", "llm-2026-04-01.md"))).toBe(true);
    expect(existsSync(join(tmp, "wiki", ".audit", "llm-2026-05-20.md"))).toBe(true);
  });
});

function auditEntry(consumer: string, referencesStripped: number, prosePathLeaks: number) {
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
    prosePathLeaks,
    prosePathLeakSamples: prosePathLeaks > 0 ? ["wiki/projects/agentmemory.md"] : [],
  };
}
