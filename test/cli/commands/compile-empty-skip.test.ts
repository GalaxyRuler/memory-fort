import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCompile } from "../../../src/cli/commands/compile.js";
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

describe("compile empty execute passes", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compile-empty-skip-"));
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(root, "raw"), { recursive: true });
    await mkdir(join(root, "wiki", "projects"), { recursive: true });
    await writeFile(join(root, "prompts", "compile.md"), TEMPLATE);
    await writeFile(join(root, "schema.md"), "# Schema\n");
    await writeFile(join(root, "index.md"), "# Index\n");
    await writeFile(join(root, "log.md"), "# Log\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not call the LLM for an empty raw execute pass", async () => {
    const chat = vi.fn(async () => ({
      model: "llama3.2",
      finishReason: "stop" as const,
      rawProviderName: "ollama",
      content: "```compile-ops\n{\"operations\":[]}\n```",
    }));
    const fakeFactory = () => ({
      providerName: "ollama",
      modelName: "llama3.2",
      chat,
    } satisfies LLMProvider);

    const result = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: fakeFactory,
      env: {},
    });

    expect(result.rawFilesIncluded).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it("still consolidates pending compressed facts when no raw files are included", async () => {
    await writeFile(
      join(root, "wiki", "projects", "memory-system.md"),
      [
        "---",
        "type: projects",
        "title: Memory System",
        "created: 2026-05-31",
        "updated: 2026-05-31",
        "status: active",
        "lifecycle: consolidated",
        "source: compile-execute",
        "version: 1",
        "---",
        "",
        "Memory System captures raw observations.",
        "",
      ].join("\n"),
    );
    for (const id of ["a", "b", "c"]) {
      await writeFact(`facts/2026-05-31/${id}.json`, {
        title: `Memory System ${id}`,
        facts: [`Memory System fact ${id}.`],
        narrative: `Memory System narrative ${id}.`,
        concepts: ["Memory System"],
        files: [],
        importance: 8,
        sessionId: id,
        sourceRawPath: `raw/2026-05-31/${id}.md`,
        observedAt: "2026-05-31T12:00:00.000Z",
        compressedAt: "2026-05-31T12:00:00.000Z",
      });
    }

    const result = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeFactConsolidationLLM(),
      env: {},
    });

    expect(result.rawFilesIncluded).toEqual([]);
    expect(result.execution?.applied).toEqual(["wiki/projects/memory-system.md"]);
    expect(await readFile(join(root, "wiki", "projects", "memory-system.md"), "utf-8"))
      .toContain("Memory System fact c.");
  });

  async function writeFact(relPath: string, fact: Record<string, unknown>): Promise<void> {
    const fullPath = join(root, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, `${JSON.stringify({ facts: [fact] }, null, 2)}\n`);
  }
});

function fakeFactConsolidationLLM(): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async (request) => {
      if (request.jsonSchema?.name === "NarrativeDetectOutput") {
        return fakeJsonResponse(JSON.stringify({
          contradicted_claims: [],
          net_new_facts: ["Memory System fact a.", "Memory System fact b.", "Memory System fact c."],
        }));
      }
      if (request.jsonSchema?.name === "NarrativeSynthesisOutput") {
        return fakeJsonResponse(JSON.stringify({
          body: [
            "Memory System captures raw observations.",
            "",
            "Memory System fact a.",
            "Memory System fact b.",
            "Memory System fact c.",
          ].join("\n"),
        }));
      }
      throw new Error(`unexpected schema ${request.jsonSchema?.name ?? "none"}`);
    }),
  };
}

function fakeJsonResponse(content: string) {
  return {
    model: "llama3.2",
    finishReason: "stop" as const,
    rawProviderName: "ollama",
    tokensUsed: { prompt: 10, completion: 10, total: 20 },
    content,
  };
}
