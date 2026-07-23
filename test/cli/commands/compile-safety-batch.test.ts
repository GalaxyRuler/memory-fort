import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCompile } from "../../../src/cli/commands/compile.js";
import { readCompileStateFile } from "../../../src/compile/state.js";
import type { LLMProvider } from "../../../src/llm/types.js";

const TEMPLATE = [
  "# memory:custom",
  "SCHEMA={{schema_content}}",
  "INDEX={{index_content}}",
  "EXISTING={{existing_pages}}",
  "LOG={{recent_log_lines}}",
  "FILES={{raw_files_list}}",
  "RAW={{raw_content}}",
].join("\n");

describe("compile response safety", () => {
  let tmp: string;
  let root: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compile-safety-batch-"));
    root = join(tmp, ".memory");
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(root, "raw", "2026-07-23"), { recursive: true });
    await writeFile(join(root, "prompts", "compile.md"), TEMPLATE);
    await writeFile(join(root, "schema.md"), "# Schema\n");
    await writeFile(join(root, "index.md"), "# Index\n");
    await writeFile(join(root, "log.md"), "# Log\n");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("rejects a mixed valid and malformed response atomically without canonical writes or raw watermarks", async () => {
    await writeRaw("a.md", "Evidence Alpha: compile batches must be atomic.");
    await writeRaw("b.md", "Evidence Beta: raw watermarks advance only after a complete batch.");
    const result = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => mixedBatchLlm(),
      env: {},
    });

    expect(result.execution?.rawInputConsumed).toBe(false);
    expect(result.execution?.outcomes).toEqual([expect.objectContaining({
      path: "(response)",
      outcome: "rejected",
      reason: expect.stringContaining("invalid operation"),
    })]);
    expect(result.watermarksAdvanced).toEqual([]);
    expect(existsSync(join(root, "wiki", "lessons", "atomic-batch.md"))).toBe(false);
    const state = await readCompileStateFile(root);
    expect(state.consumed ?? {}).not.toHaveProperty("raw/2026-07-23/a.md");
    expect(state.consumed ?? {}).not.toHaveProperty("raw/2026-07-23/b.md");
  });

  it("passes exact compile raw evidence to the faithfulness judge before applying a supported write", async () => {
    await writeRaw("a.md", "Evidence Alpha: compile writes need exact source facts.");
    await writeRaw("b.md", "Evidence Beta: the faithfulness judge must inspect those facts.");
    const body = "Compile writes need exact source facts and the faithfulness judge must inspect those facts.";
    const llm = evidenceMatchingLlm(body, false);

    const result = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
    });

    expect(result.execution?.applied).toEqual(["wiki/lessons/evidence-grounded.md"]);
    expect(result.watermarksAdvanced).toEqual([
      "raw/2026-07-23/a.md",
      "raw/2026-07-23/b.md",
    ]);
    expect(existsSync(join(root, "wiki", "lessons", "evidence-grounded.md"))).toBe(true);
    const judgePrompt = vi.mocked(llm.chat).mock.calls.find(([request]) => request.jsonSchema?.name === "FaithfulnessOutput")?.[0].messages.at(-1)?.content ?? "";
    expect(judgePrompt).toContain("Evidence Alpha: compile writes need exact source facts.");
    expect(judgePrompt).toContain("Evidence Beta: the faithfulness judge must inspect those facts.");
  });

  it("holds raw watermarks when one valid batch operation is rejected during apply", async () => {
    await writeRaw("a.md", "Evidence Alpha: a batch must retain raw input after any rejection.");
    await writeRaw("b.md", "Evidence Beta: applied siblings must not hide a rejected operation.");
    const result = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => applicationRejectedBatchLlm("A supported write can apply before a sibling rejects."),
      env: {},
    });

    expect(result.execution?.rawInputConsumed).toBe(false);
    expect(result.execution?.applied).toEqual(["wiki/lessons/evidence-grounded.md"]);
    expect(result.execution?.rejected).toEqual([expect.objectContaining({
      path: "../outside-vault.md",
      reason: "path outside allowed vault targets",
    })]);
    expect(result.watermarksAdvanced).toEqual([]);
    const state = await readCompileStateFile(root);
    expect(state.consumed ?? {}).not.toHaveProperty("raw/2026-07-23/a.md");
    expect(state.consumed ?? {}).not.toHaveProperty("raw/2026-07-23/b.md");
  });

  it("stages an unsupported compile write and holds its raw watermarks", async () => {
    await writeRaw("a.md", "Evidence Alpha: supported writes use raw facts.");
    await writeRaw("b.md", "Evidence Beta: unsupported claims stay proposed.");
    const llm = evidenceMatchingLlm("This unsupported claim invented a private orbital relay.", true);

    const result = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
    });

    expect(result.execution?.applied).toEqual([]);
    expect(result.execution?.proposed).toContain("wiki/compile-proposed/evidence-grounded.md");
    expect(result.watermarksAdvanced).toEqual([]);
    expect(existsSync(join(root, "wiki", "lessons", "evidence-grounded.md"))).toBe(false);
  });

  async function writeRaw(name: string, content: string): Promise<void> {
    await writeFile(join(root, "raw", "2026-07-23", name), `${content}\n`, "utf-8");
  }
});

function applicationRejectedBatchLlm(body: string): LLMProvider {
  return responseLlm((request) => {
    if (request.jsonSchema?.name === "FaithfulnessOutput") {
      return { unsupported_claims: [] };
    }
    return {
      operations: [
        operation(body),
        { kind: "write_page", path: "../outside-vault.md", frontmatter: {}, body: "Rejected sibling." },
      ],
    };
  });
}

function mixedBatchLlm(): LLMProvider {
  return responseLlm(() => ({
    operations: [
      operation("Atomic compile batch content."),
      { kind: "unsupported_operation", path: "wiki/lessons/ignored.md" },
    ],
  }));
}

function evidenceMatchingLlm(body: string, forceUnsupported: boolean): LLMProvider {
  return responseLlm((request) => {
    if (request.jsonSchema?.name === "FaithfulnessOutput") {
      const prompt = request.messages.at(-1)?.content ?? "";
      const hasExactEvidence = prompt.includes("Evidence Alpha:") && prompt.includes("Evidence Beta:");
      return {
        unsupported_claims: forceUnsupported || !hasExactEvidence ? [body] : [],
      };
    }
    return { operations: [operation(body)] };
  });
}

function responseLlm(factory: (request: Parameters<LLMProvider["chat"]>[0]) => unknown): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async (request) => {
      const payload = JSON.stringify(factory(request));
      return {
        model: "llama3.2",
        finishReason: "stop" as const,
        rawProviderName: "ollama",
        content: request.jsonSchema?.name === "FaithfulnessOutput"
          ? payload
          : `\`\`\`compile-ops\n${payload}\n\`\`\``,
      };
    }),
  };
}

function operation(body: string) {
  return {
    kind: "write_page",
    path: "wiki/lessons/evidence-grounded.md",
    frontmatter: {
      type: "lessons",
      title: "Evidence grounded",
      relations: {
        derived_from: ["raw/2026-07-23/a.md", "raw/2026-07-23/b.md"],
      },
    },
    body,
  };
}
