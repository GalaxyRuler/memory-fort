import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatWithAudit,
  hashPrompt,
  hashResponse,
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
    });

    const content = await readFile(
      join(tmp, "wiki", ".audit", "llm-2026-05-27.md"),
      "utf-8",
    );
    expect(content).toContain("# LLM audit log 2026-05-27");
    expect(content).toContain("auto-thread-propose");
    expect(content).toContain("| references_stripped |");
    expect(content).toContain("wiki/decisions/invented.md");
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
      referencesStripped: 0,
    }]);
    vi.useRealTimers();
  });
});
