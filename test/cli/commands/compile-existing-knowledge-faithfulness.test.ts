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

describe("compile existing knowledge-page faithfulness", () => {
  let tmp: string;
  let root: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compile-existing-faithfulness-"));
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

  it("stages an unsupported generated append to an existing knowledge page and holds the raw watermark", async () => {
    const originalBody = "Memory System stores durable local notes.";
    const rawEvidence = "Evidence Alpha: Memory System stores durable local notes.";
    const generatedClaim = "Memory System runs a private orbital relay.";
    await writeExistingKnowledgePage(originalBody);
    await writeRaw("unsupported.md", rawEvidence);
    const llm = existingKnowledgeEvidenceLlm({ rawEvidence, generatedClaim, originalBody, operationKind: "append_page" });

    const result = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
    });

    expect(result.execution?.applied).toEqual([]);
    expect(result.execution?.proposed).toEqual(["wiki/compile-proposed/memory-system.md"]);
    expect(result.watermarksAdvanced).toEqual([]);
    const canonical = await readFile(join(root, "wiki", "projects", "memory-system.md"), "utf-8");
    expect(canonical).toContain(originalBody);
    expect(canonical).not.toContain(generatedClaim);
    const state = await readCompileStateFile(root);
    expect(state.consumed ?? {}).not.toHaveProperty("raw/2026-07-23/unsupported.md");
  });

  it("permits a generated existing-page write when its raw evidence supports it", async () => {
    const originalBody = "Memory System stores durable local notes.";
    const generatedClaim = "Memory System supports encrypted local snapshots.";
    const rawEvidence = `Evidence Alpha: ${generatedClaim}`;
    await writeExistingKnowledgePage(originalBody);
    await writeRaw("supported.md", rawEvidence);
    const llm = existingKnowledgeEvidenceLlm({ rawEvidence, generatedClaim, originalBody, operationKind: "write_page" });

    const result = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
    });

    expect(result.execution?.applied).toEqual(["wiki/projects/memory-system.md"]);
    expect(result.execution?.proposed).toEqual([]);
    expect(result.watermarksAdvanced).toEqual(["raw/2026-07-23/supported.md"]);
    const canonical = await readFile(join(root, "wiki", "projects", "memory-system.md"), "utf-8");
    expect(canonical).toContain(originalBody);
    expect(canonical).toContain(generatedClaim);
    const firstFaithfulnessPrompt = vi.mocked(llm.chat).mock.calls
      .find(([request]) => request.jsonSchema?.name === "FaithfulnessOutput")?.[0].messages.at(-1)?.content ?? "";
    expect(firstFaithfulnessPrompt).toContain(rawEvidence);
  });

  async function writeRaw(name: string, content: string): Promise<void> {
    await writeFile(join(root, "raw", "2026-07-23", name), `${content}\n`, "utf-8");
  }

  async function writeExistingKnowledgePage(body: string): Promise<void> {
    await mkdir(join(root, "wiki", "projects"), { recursive: true });
    await writeFile(join(root, "wiki", "projects", "memory-system.md"), [
      "---",
      "type: projects",
      "title: Memory System",
      "created: 2026-07-23",
      "updated: 2026-07-23",
      "---",
      "",
      body,
      "",
    ].join("\n"), "utf-8");
  }
});

function existingKnowledgeEvidenceLlm(opts: {
  rawEvidence: string;
  generatedClaim: string;
  originalBody: string;
  operationKind: "append_page" | "write_page";
}): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async (request) => {
      const schemaName = request.jsonSchema?.name;
      if (schemaName === "FaithfulnessOutput") {
        const prompt = request.messages.at(-1)?.content ?? "";
        const rawEvidenceWasProvided = prompt.includes(opts.rawEvidence);
        return jsonResponse({
          unsupported_claims: rawEvidenceWasProvided && !opts.rawEvidence.includes(opts.generatedClaim)
            ? [opts.generatedClaim]
            : [],
        });
      }
      if (schemaName === "NarrativeDetectOutput") {
        return jsonResponse({ contradicted_claims: [], net_new_facts: [opts.generatedClaim] });
      }
      if (schemaName === "NarrativeSynthesisOutput") {
        return jsonResponse({ body: `${opts.originalBody}\n\n${opts.generatedClaim}` });
      }
      const operation = opts.operationKind === "append_page"
        ? { kind: "append_page", path: "wiki/projects/memory-system.md", section: opts.generatedClaim }
        : {
            kind: "write_page",
            path: "wiki/projects/memory-system.md",
            frontmatter: { type: "projects", title: "Memory System" },
            body: opts.generatedClaim,
          };
      return {
        ...jsonResponse({ operations: [operation] }),
        content: `\`\`\`compile-ops\n${JSON.stringify({ operations: [operation] })}\n\`\`\``,
      };
    }),
  };
}

function jsonResponse(payload: unknown) {
  return {
    model: "llama3.2",
    finishReason: "stop" as const,
    rawProviderName: "ollama",
    content: JSON.stringify(payload),
  };
}
