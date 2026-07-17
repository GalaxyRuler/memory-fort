import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeCompilePrompt } from "../../src/cli/commands/compile.js";
import type { LLMProvider, LLMFinishReason } from "../../src/llm/types.js";

// A response the parser accepts: one valid write_page op. Under finishReason
// "stop" it must apply; under "length"/"filter" it must be refused before apply.
const VALID_OPS_RESPONSE = [
  "```json",
  JSON.stringify({
    operations: [{
      kind: "write_page",
      path: "wiki/lessons/truncation-test.md",
      body: "A valid operation that must not apply when the response was truncated.",
    }],
  }),
  "```",
].join("\n");

function llmWith(finishReason: LLMFinishReason): LLMProvider {
  return {
    providerName: "fake",
    modelName: "fake-model",
    chat: async () => ({
      content: VALID_OPS_RESPONSE,
      model: "fake-model",
      finishReason,
      rawProviderName: "fake",
      tokensUsed: { prompt: 10, completion: 5, total: 15 },
    }),
  };
}

describe("compile truncation gate", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compile-trunc-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function run(finishReason: LLMFinishReason) {
    return executeCompilePrompt({
      root,
      prompt: "compile these observations",
      hasRawContent: true,
      skipFactConsolidation: true,
      configLoader: async () => ({}),
      llmFactory: () => llmWith(finishReason),
    });
  }

  it("control: a valid op is processed and consumes input under finishReason=stop", async () => {
    const result = await run("stop");
    expect(result.rawInputConsumed).toBe(true);
    // The op is either applied or staged for review, but it IS processed.
    expect(result.applied.length + result.proposed.length).toBeGreaterThan(0);
  });

  it.each(["length", "filter"] as const)(
    "holds the watermark and processes nothing when finishReason=%s",
    async (finishReason) => {
      const result = await run(finishReason);
      expect(result.rawInputConsumed).toBe(false);
      expect(result.applied).toEqual([]);
      expect(result.proposed).toEqual([]);
      // Conservation: the gate returns before applyCompileOperations, so the page
      // the truncated op targeted is never written.
      expect(existsSync(join(root, "wiki", "lessons", "truncation-test.md"))).toBe(false);
    },
  );
});
