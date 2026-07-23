import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCompress } from "../../src/cli/commands/compress.js";
import { readCompileStateFile } from "../../src/compile/state.js";
import type { LLMProvider } from "../../src/llm/types.js";

describe("compression rejection review", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("records an inspectable review record for a rejected unsupported bundle without facts or watermark", async () => {
    const root = await setup("session-unsupported.md");
    const relPath = "raw/2026-07-17/session-unsupported.md";
    const llm = responseLlm({
      facts: [{
        title: "Memory System Mars relay",
        facts: ["Memory System deployed a Mars relay."],
        narrative: "Memory System deployed a Mars relay.",
        concepts: ["Memory System"],
        files: [],
        importance: 8,
        evidence: "Memory System shipped Phase 3 retrieval.",
      }],
    }, { unsupported_claims: ["Memory System deployed a Mars relay."] });

    const result = await runCompress({
      vaultRoot: root,
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
    });

    expect(result.files.find((file) => file.path === relPath)).toMatchObject({ outcome: "failed" });
    expect(existsSync(join(root, "facts", "2026-07-17", "session-unsupported.json"))).toBe(false);
    expect((await readCompileStateFile(root)).compressed?.[relPath]).toBeUndefined();
    const reviewDir = join(root, "wiki", ".audit", "compress-rejections");
    const reviews = await readdir(reviewDir);
    expect(reviews).toHaveLength(1);
    const review = await readFile(join(reviewDir, reviews[0]!), "utf-8");
    expect(review).toContain(relPath);
    expect(review).toContain("unsupported");
  });

  it("rejects a substantive schema-valid empty bundle before fact or watermark persistence", async () => {
    const root = await setup("session-empty.md");
    const relPath = "raw/2026-07-17/session-empty.md";
    const llm = responseLlm({ facts: [] });

    const result = await runCompress({
      vaultRoot: root,
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
    });

    expect(result.files.find((file) => file.path === relPath)).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("empty fact bundle"),
    });
    expect(existsSync(join(root, "facts", "2026-07-17", "session-empty.json"))).toBe(false);
    expect((await readCompileStateFile(root)).compressed?.[relPath]).toBeUndefined();
  });

  async function setup(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "memory-compress-review-"));
    roots.push(root);
    await mkdir(join(root, "raw", "2026-07-17"), { recursive: true });
    await writeFile(
      join(root, "raw", "2026-07-17", name),
      "## [10:00:00] Observation\nMemory System shipped Phase 3 retrieval.\n",
      "utf-8",
    );
    return root;
  }
});

function responseLlm(facts: unknown, faithfulness = { unsupported_claims: [] }): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async (request) => ({
      model: "llama3.2",
      finishReason: "stop" as const,
      rawProviderName: "ollama",
      content: request.jsonSchema?.name === "FaithfulnessOutput"
        ? JSON.stringify(faithfulness)
        : JSON.stringify(facts),
    })),
  };
}
