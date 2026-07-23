import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCompress } from "../../src/cli/commands/compress.js";
import { readCompileStateFile } from "../../src/compile/state.js";
import type { LLMProvider } from "../../src/llm/types.js";

describe("compression grounding gate", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("holds a schema-valid but unsupported fact bundle out of canonical facts and the compression watermark", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-compress-grounding-"));
    roots.push(root);
    const relPath = "raw/2026-07-17/session-grounding.md";
    await mkdir(join(root, "raw", "2026-07-17"), { recursive: true });
    await writeFile(join(root, relPath), "## [10:00:00] Observation\nMemory System shipped Phase 3 retrieval.\n", "utf-8");
    const llm: LLMProvider = {
      providerName: "ollama",
      modelName: "llama3.2",
      chat: vi.fn(async (request) => {
        if (request.jsonSchema?.name === "FaithfulnessOutput") {
          return {
            model: "llama3.2",
            finishReason: "stop" as const,
            rawProviderName: "ollama",
            content: JSON.stringify({ unsupported_claims: ["Memory System deployed a Mars relay."] }),
          };
        }
        return {
          model: "llama3.2",
          finishReason: "stop" as const,
          rawProviderName: "ollama",
          content: JSON.stringify({
            facts: [{
              title: "Memory System Mars relay",
              facts: ["Memory System deployed a Mars relay."],
              narrative: "Memory System deployed a Mars relay.",
              concepts: ["Memory System"],
              files: [],
              importance: 8,
              type: "project",
              evidence: "Memory System shipped Phase 3 retrieval.",
            }],
          }),
        };
      }),
    };

    const result = await runCompress({
      vaultRoot: root,
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
    });

    expect(result.files.find((file) => file.path === relPath)).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("unsupported"),
    });
    expect(existsSync(join(root, "facts", "2026-07-17", "session-grounding.json"))).toBe(false);
    const state = await readCompileStateFile(root);
    expect(state.compressed?.[relPath]).toBeUndefined();
  });
});
