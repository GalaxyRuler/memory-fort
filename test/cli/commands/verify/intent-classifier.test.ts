import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { intentClassifierHealthCheck } from "../../../../src/cli/commands/verify/intent-classifier.js";

describe("intentClassifierHealthCheck", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "intent-health-"));
    await mkdir(join(tmp, "wiki", ".audit"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("passes with no classifier audit history", async () => {
    const result = await intentClassifierHealthCheck.run({
      vaultRoot: tmp,
      now: () => new Date("2026-05-28T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      id: "retrieval.intent-classifier-health",
      status: "pass",
    });
    expect(result.detail).toContain("no query-intent-classify LLM calls");
  });

  it("warns when recent LLM classifier call volume is high", async () => {
    await writeAudit(60, 0);

    const result = await intentClassifierHealthCheck.run({
      vaultRoot: tmp,
      now: () => new Date("2026-05-28T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "warn",
      suggestedFix: "tune query intent heuristics",
    });
    expect(result.detail).toContain("llm calls: 60");
  });

  it("fails when recent classifier errors exceed 10 percent over at least 20 calls", async () => {
    await writeAudit(20, 3);

    const result = await intentClassifierHealthCheck.run({
      vaultRoot: tmp,
      now: () => new Date("2026-05-28T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "fail",
      suggestedFix: "inspect wiki/.audit/llm-*.md for query-intent-classify errors",
    });
    expect(result.detail).toContain("error rate: 15.0%");
  });

  async function writeAudit(total: number, errors: number): Promise<void> {
    const lines = [
      "# LLM audit log 2026-05-28",
      "",
      "| ts | consumer | provider | model | prompt_hash | response_hash | tokens_in | tokens_out | duration_ms | cost_usd | finish | error |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (let index = 0; index < total; index += 1) {
      const isError = index < errors;
      lines.push(`| 2026-05-28T00:00:00.000Z | query-intent-classify | ollama | llama3.2 | a | b | 8 | 1 | 3 | 0 | ${isError ? "error" : "stop"} | ${isError ? "boom" : ""} |`);
    }
    await writeFile(join(tmp, "wiki", ".audit", "llm-2026-05-28.md"), `${lines.join("\n")}\n`, "utf-8");
  }
});
