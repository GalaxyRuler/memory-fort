import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCurate } from "../../../src/cli/commands/curate.js";
import type { LLMProvider } from "../../../src/llm/types.js";
import { parseFrontmatter } from "../../../src/storage/frontmatter.js";

describe("runCurate", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "curate-"));
    await writeFileAt("schema.md", "# Schema\n");
    await writeFileAt("wiki/projects/memory-fort.md", page([
      "Memory Fort stores durable memory.",
      "",
      "## 2026-05-30 update",
      "",
      "Memory Fort records compile observations.",
      "",
      "## 2026-05-31 update",
      "",
      "Memory Fort records compile observations.",
      "Memory Fort now supports curate-merge consolidation.",
    ].join("\n")));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("applies a non-shrinking curated rewrite and is idempotent on re-run", async () => {
    const llm = fakeCurateLLM([
      "Memory Fort stores durable memory and records compile observations.",
      "",
      "It now supports curate-merge consolidation.",
    ].join("\n"));

    const first = await runCurate({
      vaultRoot: tmp,
      target: "wiki/projects/memory-fort.md",
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:00.000Z"),
    });
    const second = await runCurate({
      vaultRoot: tmp,
      target: "wiki/projects/memory-fort.md",
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:01.000Z"),
    });

    expect(first.pages).toEqual([{
      path: "wiki/projects/memory-fort.md",
      outcome: "rewritten",
      proposed: false,
    }]);
    expect(second.pages).toEqual([{
      path: "wiki/projects/memory-fort.md",
      outcome: "skipped: no new content",
      proposed: false,
    }]);
    const written = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8"));
    expect(written.body.match(/^## 2026-/gm) ?? []).toHaveLength(0);
    expect(written.body).toContain("stores durable memory");
    expect(written.body).toContain("compile observations");
    expect(written.body).toContain("curate-merge consolidation");
    expect(existsSync(join(tmp, "wiki", ".history", "wiki", "projects", "memory-fort.md", "2026-05-31T12-00-00-000Z.md"))).toBe(true);
  });

  async function writeFileAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function page(body: string): string {
  return [
    "---",
    "type: projects",
    "title: Memory Fort",
    "created: 2026-05-30",
    "updated: 2026-05-30",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function fakeCurateLLM(body: string): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async () => ({
      model: "llama3.2",
      finishReason: "stop",
      rawProviderName: "ollama",
      content: [
        "```compile-op",
        JSON.stringify({
          kind: "rewrite_page",
          path: "wiki/projects/memory-fort.md",
          frontmatter: { title: "Memory Fort", confidence: 0.9 },
          body,
        }),
        "```",
      ].join("\n"),
    })),
  };
}
