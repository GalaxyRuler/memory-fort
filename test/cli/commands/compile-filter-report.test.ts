import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCompile } from "../../../src/cli/commands/compile.js";
import { compileStatePath, legacyCompileStatePath } from "../../../src/compile/state.js";
import type { LLMProvider } from "../../../src/llm/types.js";

const TEMPLATE = [
  "# memory:custom",
  "RAW={{raw_content}}",
].join("\n");

describe("runCompile filter report", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compile-filter-report-"));
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(root, "raw", "2026-06-14"), { recursive: true });
    await mkdir(join(root, "wiki"), { recursive: true });
    await writeFile(join(root, "prompts", "compile.md"), TEMPLATE);
    await writeFile(join(root, "schema.md"), "# Schema\n");
    await writeFile(join(root, "index.md"), "# Index\n");
    await writeFile(join(root, "log.md"), "# Log\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns a dry-run filter report without LLM calls or state writes", async () => {
    await writeFile(join(root, "raw", "2026-06-14", "mixed.md"), [
      rawTurn("ToolResult", JSON.stringify({ content: "x".repeat(1_000) })),
      rawTurn("Prompt", "Remember the launch checklist."),
    ].join(""));
    await writeFile(
      join(root, "raw", "2026-06-14", "noise.md"),
      rawTurn("ToolResult", "dist/assets/app-a1b2c3.js    12.00 kB | gzip: 3.00 kB\n"),
    );
    const priorState = `${JSON.stringify({ consumed: {}, lastFilterStats: { bytesIn: 1 } }, null, 2)}\n`;
    await mkdir(join(root, "var", "compile"), { recursive: true });
    await writeFile(compileStatePath(root), priorState);
    const beforeStat = await stat(compileStatePath(root));
    const chat = vi.fn(async () => emptyOpsResponse());

    const result = await runCompile({
      vaultRoot: root,
      filterReport: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM(chat),
      env: {},
    });

    const afterStat = await stat(compileStatePath(root));
    expect(chat).not.toHaveBeenCalled();
    expect(await readFile(compileStatePath(root), "utf-8")).toBe(priorState);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(result.filterReport?.perFile).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relPath: "raw/2026-06-14/mixed.md",
        noiseOnly: false,
      }),
      expect.objectContaining({
        relPath: "raw/2026-06-14/noise.md",
        noiseOnly: true,
      }),
    ]));
    expect(result.filterReport?.aggregate.bytesIn).toBeGreaterThan(result.filterReport?.aggregate.bytesOut ?? 0);
    expect(result.filterReport?.aggregate.noiseOnlyFiles).toBe(1);
    expect(result.filterReport?.aggregate.strippedByClass["json-fat-field"]).toBeGreaterThan(0);
  });

  it("does not migrate legacy compile state while producing a filter report", async () => {
    await mkdir(join(root, "state"), { recursive: true });
    const alreadyRead = "already read";
    const legacyState = `${JSON.stringify({
      consumed: {
        "raw/2026-06-14/already.md": { bytes: Buffer.byteLength(alreadyRead) },
      },
    }, null, 2)}\n`;
    await writeFile(legacyCompileStatePath(root), legacyState);
    await writeFile(join(root, "raw", "2026-06-14", "already.md"), alreadyRead);
    await writeFile(join(root, "raw", "2026-06-14", "fresh.md"), rawTurn("Prompt", "Fresh signal"));
    const legacyBefore = await stat(legacyCompileStatePath(root));

    const result = await runCompile({
      vaultRoot: root,
      filterReport: true,
    });

    const legacyAfter = await stat(legacyCompileStatePath(root));
    expect(existsSync(compileStatePath(root))).toBe(false);
    expect(await readFile(legacyCompileStatePath(root), "utf-8")).toBe(legacyState);
    expect(legacyAfter.mtimeMs).toBe(legacyBefore.mtimeMs);
    expect(result.filterReport?.perFile.map((item) => item.relPath)).toEqual(["raw/2026-06-14/fresh.md"]);
  });
});

function rawTurn(kind: string, body: string): string {
  return `## [12:00:00] ${kind}\n\n${body}\n`;
}

function fakeLLM(chat: LLMProvider["chat"]): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat,
  };
}

function emptyOpsResponse() {
  return {
    model: "llama3.2",
    finishReason: "stop" as const,
    rawProviderName: "ollama",
    content: "```compile-ops\n{\"operations\":[]}\n```",
  };
}
