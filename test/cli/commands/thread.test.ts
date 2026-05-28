import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatThreadProposeResult,
  runThreadPromote,
  runThreadPropose,
  runThreadReject,
} from "../../../src/cli/commands/thread.js";
import { parseFrontmatter } from "../../../src/storage/frontmatter.js";
import type { LLMProvider } from "../../../src/llm/types.js";

describe("thread commands", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-thread-"));
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await writeMarkdown("wiki/projects/memory-fort.md", page("projects", "Memory Fort", "Shared project page."));
    await writeMarkdown("wiki/decisions/settings-ui.md", page("decisions", "Settings UI", "Decision."));
    await writeMarkdown("wiki/lessons/env-secrets.md", page("lessons", "Env Secrets", "Lesson."));
    for (let index = 1; index <= 3; index += 1) {
      await writeMarkdown(
        `raw/2026-05-2${index}/codex-${index}.md`,
        rawPage(`Raw ${index}`, `Observation ${index} about Memory Fort settings.`, ["wiki/projects/memory-fort.md"]),
      );
    }
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("plans proposals without writing draft thread pages", async () => {
    const result = await runThreadPropose({
      vaultRoot: tmp,
      apply: false,
      days: 30,
      maxProposals: 1,
      now: new Date("2026-05-28T12:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM("memory-fort-settings"),
      env: {},
    });

    expect(result.scanned).toBe(3);
    expect(result.clustered).toBe(1);
    expect(result.proposed).toBe(1);
    expect(result.written).toBe(0);
    expect(result.referencesStripped).toBe(0);
    expect(result.proposals[0]).toMatchObject({
      slug: "memory-fort-settings",
      relPath: "wiki/threads-proposed/memory-fort-settings.md",
      observationCount: 3,
    });
    expect(existsSync(join(tmp, "wiki", "threads-proposed", "memory-fort-settings.md"))).toBe(false);
    expect(existsSync(result.auditLogPath)).toBe(true);
    expect(formatThreadProposeResult(result)).toContain("Mode: plan");
    expect(formatThreadProposeResult(result)).toContain("References stripped: 0 (avg 0.0 per proposal)");
  });

  it("applies proposals to wiki/threads-proposed and handles slug collisions", async () => {
    await writeMarkdown(
      "wiki/threads-proposed/memory-fort-settings.md",
      page("threads", "Existing Draft", "Already present."),
    );

    const result = await runThreadPropose({
      vaultRoot: tmp,
      apply: true,
      days: 30,
      maxProposals: 1,
      now: new Date("2026-05-28T12:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM("memory-fort-settings"),
      env: {},
    });

    expect(result.written).toBe(1);
    expect(result.proposals[0]?.slug).toBe("memory-fort-settings-2");
    const draftPath = join(tmp, "wiki", "threads-proposed", "memory-fort-settings-2.md");
    const draft = parseFrontmatter(await readFile(draftPath, "utf-8"));
    expect(draft.frontmatter.lifecycle).toBe("proposed");
    expect(draft.frontmatter.source).toBe("auto-thread-propose");
    expect(draft.frontmatter.relations?.mentions).toEqual([
      "raw/2026-05-21/codex-1.md",
      "raw/2026-05-22/codex-2.md",
      "raw/2026-05-23/codex-3.md",
    ]);
    expect(existsSync(join(tmp, "wiki", "threads", "memory-fort-settings-2.md"))).toBe(false);
  });

  it("auto-promotes high-confidence thread proposals when requested", async () => {
    for (let index = 4; index <= 5; index += 1) {
      await writeMarkdown(
        `raw/2026-05-2${index}/codex-${index}.md`,
        rawPage(`Raw ${index}`, `Observation ${index} about Memory Fort settings.`, ["wiki/projects/memory-fort.md"]),
      );
    }

    const result = await runThreadPropose({
      vaultRoot: tmp,
      apply: true,
      autoPromote: true,
      days: 30,
      maxProposals: 1,
      now: new Date("2026-05-28T12:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM("memory-fort-settings"),
      env: {},
    });

    expect(result.written).toBe(1);
    expect(result.autoPromoted).toBe(1);
    expect(result.awaitingReview).toBe(0);
    expect(result.proposals[0]).toMatchObject({
      relPath: "wiki/threads/memory-fort-settings.md",
      autoPromoted: true,
      confidence: { level: "high", reasons: ["all signals clean"] },
    });
    expect(existsSync(join(tmp, "wiki", "threads", "memory-fort-settings.md"))).toBe(true);
    expect(existsSync(join(tmp, "wiki", "threads-proposed", "memory-fort-settings.md"))).toBe(false);
    expect(formatThreadProposeResult(result)).toContain("Drafts auto-promoted: 1");
    expect(formatThreadProposeResult(result)).toContain("Drafts awaiting review: 0");
    expect(await readFile(result.auditLogPath, "utf-8")).toContain("autoPromoted: true");
  });

  it("keeps low-confidence thread proposals in review even with auto-promote enabled", async () => {
    const result = await runThreadPropose({
      vaultRoot: tmp,
      apply: true,
      autoPromote: true,
      days: 30,
      maxProposals: 1,
      now: new Date("2026-05-28T12:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM("memory-fort-settings"),
      env: {},
    });

    expect(result.autoPromoted).toBe(0);
    expect(result.awaitingReview).toBe(1);
    expect(result.proposals[0]).toMatchObject({
      relPath: "wiki/threads-proposed/memory-fort-settings.md",
      autoPromoted: false,
      confidence: {
        level: "low",
        reasons: ["observationCount=3 below threshold 5"],
      },
    });
    expect(existsSync(join(tmp, "wiki", "threads-proposed", "memory-fort-settings.md"))).toBe(true);
  });

  it("does not write path-leaked prose fields to proposed thread drafts", async () => {
    const result = await runThreadPropose({
      vaultRoot: tmp,
      apply: true,
      days: 30,
      maxProposals: 1,
      now: new Date("2026-05-28T12:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM("memory-fort-settings", {
        decision: "wiki/decisions/invented.md",
        lesson: "wiki/lessons/env-secrets.md",
      }),
      env: {},
    });

    expect(result.referencesStripped).toBe(0);
    const draft = await readFile(join(tmp, "wiki", "threads-proposed", "memory-fort-settings.md"), "utf-8");
    expect(draft).not.toContain("wiki/decisions/invented.md");
    expect(draft).not.toContain("wiki/lessons/env-secrets.md");
    const llmAudit = await readFile(join(tmp, "wiki", ".audit", "llm-2026-05-28.md"), "utf-8");
    expect(llmAudit).toContain("| prose_path_leaks |");
    expect(llmAudit).toContain("wiki/decisions/invented.md");
  });

  it("skips malformed LLM proposals with parser reasons and continues writing the run audit", async () => {
    const result = await runThreadPropose({
      vaultRoot: tmp,
      apply: true,
      days: 30,
      maxProposals: 1,
      now: new Date("2026-05-28T12:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => ({
        providerName: "ollama",
        modelName: "llama3.2",
        chat: vi.fn(async () => ({
          content: "not: [valid",
          model: "llama3.2",
          finishReason: "stop",
          rawProviderName: "ollama",
        })),
      }),
      env: {},
    });

    expect(result.proposed).toBe(0);
    expect(result.written).toBe(0);
    expect(result.skipped).toEqual([{
      clusterIndex: 0,
      reason: expect.stringContaining("yaml parse error:"),
    }]);
    expect(formatThreadProposeResult(result)).toContain("cluster 0: yaml parse error:");
    expect(await readFile(result.auditLogPath, "utf-8")).toContain("yaml parse error:");
  });

  it("includes prompt and response hashes for skipped clusters when debug logging is enabled", async () => {
    const result = await runThreadPropose({
      vaultRoot: tmp,
      apply: false,
      days: 30,
      maxProposals: 1,
      now: new Date("2026-05-28T12:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => ({
        providerName: "ollama",
        modelName: "llama3.2",
        chat: vi.fn(async () => ({
          content: [
            "title: Memory Fort Settings",
            "summary: Missing proposed slug.",
          ].join("\n"),
          model: "llama3.2",
          finishReason: "stop",
          rawProviderName: "ollama",
        })),
      }),
      env: { MEMORY_LLM_DEBUG_LOG: "1" },
    });

    expect(result.skipped).toEqual([{
      clusterIndex: 0,
      reason: "missing required field: proposed_slug",
      promptHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      responseHash: expect.stringMatching(/^[a-f0-9]{16}$/),
    }]);
    expect(formatThreadProposeResult(result)).toContain("hashes prompt=");
    expect(formatThreadProposeResult(result)).toContain("response=");
  });

  it("honors the MEMORY_LLM_DISABLED kill switch", async () => {
    await expect(runThreadPropose({
      vaultRoot: tmp,
      apply: false,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM("memory-fort-settings"),
      env: { MEMORY_LLM_DISABLED: "true" },
    })).rejects.toThrow("LLM access disabled by MEMORY_LLM_DISABLED=true");
  });

  it("promotes and rejects proposed thread drafts", async () => {
    await writeMarkdown(
      "wiki/threads-proposed/memory-fort-settings.md",
      [
        "---",
        "type: threads",
        "title: Memory Fort Settings",
        "created: 2026-05-28",
        "updated: 2026-05-28",
        "source: auto-thread-propose",
        "lifecycle: proposed",
        "---",
        "",
        "# Memory Fort Settings",
        "",
        "Draft body.",
      ].join("\n"),
    );
    await writeMarkdown(
      "wiki/threads-proposed/reject-me.md",
      page("threads", "Reject Me", "Draft body."),
    );

    const promoted = await runThreadPromote({ vaultRoot: tmp, slug: "memory-fort-settings" });
    const rejected = await runThreadReject({ vaultRoot: tmp, slug: "reject-me" });

    expect(promoted).toEqual({
      from: "wiki/threads-proposed/memory-fort-settings.md",
      to: "wiki/threads/memory-fort-settings.md",
    });
    expect(rejected).toEqual({ deleted: "wiki/threads-proposed/reject-me.md" });
    expect(existsSync(join(tmp, promoted.from))).toBe(false);
    expect(existsSync(join(tmp, rejected.deleted))).toBe(false);

    const canonical = parseFrontmatter(await readFile(join(tmp, promoted.to), "utf-8"));
    expect(canonical.frontmatter.lifecycle).toBe("consolidated");
    expect(canonical.frontmatter.source).toBe("auto-thread-propose-validated");
    expect(canonical.body).toContain("Draft body.");
  });

  async function writeMarkdown(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function fakeLLM(
  slug: string,
  refs: { decision?: string; lesson?: string } = {},
): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async () => ({
      content: [
        "title: Memory Fort Settings",
        "summary: |",
        "  The settings work became an operator-facing configuration arc.",
        "  It kept secrets outside the UI while making model choices editable.",
        "key_decisions:",
        `  - ${refs.decision ?? "Provider settings became editable while secrets stayed outside the UI."}`,
        "key_lessons:",
        `  - ${refs.lesson ?? "Env-only secret handling remains compatible with operator-visible config."}`,
        "open_questions:",
        "  - Should review move into the dashboard?",
        `proposed_slug: ${slug}`,
      ].join("\n"),
      model: "llama3.2",
      finishReason: "stop",
      rawProviderName: "ollama",
    })),
  };
}

function page(type: string, title: string, body: string): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "created: 2026-05-20",
    "updated: 2026-05-20",
    "---",
    "",
    body,
  ].join("\n");
}

function rawPage(title: string, body: string, mentions: string[]): string {
  return [
    "---",
    "type: raw-session",
    `title: ${title}`,
    "created: 2026-05-28",
    "updated: 2026-05-28",
    "relations:",
    "  mentions:",
    ...mentions.map((target) => `    - ${target}`),
    "---",
    "",
    body,
  ].join("\n");
}
