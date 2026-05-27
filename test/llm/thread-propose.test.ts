import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadCluster } from "../../src/consolidate/thread-cluster.js";
import { proposeThread } from "../../src/llm/thread-propose.js";
import type { LLMProvider } from "../../src/llm/types.js";

describe("proposeThread", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "thread-propose-"));
    await mkdir(join(tmp, "wiki"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("calls the LLM with the thread prompt and parses a valid YAML response", async () => {
    const chat = vi.fn(async () => ({
      content: [
        "title: Memory Fort Settings UI",
        "summary: |",
        "  A short arc about making provider settings editable.",
        "  It preserved env-var-only secrets while adding operator controls.",
        "key_decisions:",
        "  - wiki/decisions/settings-ui.md",
        "key_lessons:",
        "  - wiki/lessons/env-secrets.md",
        "open_questions:",
        "  - Should proposal review get a dashboard surface?",
        "proposed_slug: memory-fort-settings-ui",
      ].join("\n"),
      model: "openai/gpt-4o-mini",
      finishReason: "stop" as const,
      rawProviderName: "openrouter",
      tokensUsed: { prompt: 20, completion: 30, total: 50 },
    }));
    const llm = fakeLLM(chat);

    const proposal = await proposeThread({ llm, vaultRoot: tmp, cluster: cluster() });

    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]?.[0].messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Output exactly this shape"),
    });
    expect(chat.mock.calls[0]?.[0].messages[1]?.content).toContain("Cluster: 3 observations");
    expect(proposal).toEqual({
      title: "Memory Fort Settings UI",
      summary: "A short arc about making provider settings editable.\nIt preserved env-var-only secrets while adding operator controls.",
      keyDecisions: ["wiki/decisions/settings-ui.md"],
      keyLessons: ["wiki/lessons/env-secrets.md"],
      openQuestions: ["Should proposal review get a dashboard surface?"],
      proposedSlug: "memory-fort-settings-ui",
    });

    const audit = await readFile(join(tmp, "wiki", ".audit", `llm-${new Date().toISOString().slice(0, 10)}.md`), "utf-8");
    expect(audit).toContain("auto-thread-propose");
  });

  it("returns null for malformed YAML responses without throwing", async () => {
    const proposal = await proposeThread({
      llm: fakeLLM(async () => ({
        content: "title: [not valid",
        model: "openai/gpt-4o-mini",
        finishReason: "stop",
        rawProviderName: "openrouter",
      })),
      vaultRoot: tmp,
      cluster: cluster(),
    });

    expect(proposal).toBeNull();
  });

  it("returns null when the model elects to skip the cluster", async () => {
    const proposal = await proposeThread({
      llm: fakeLLM(async () => ({
        content: "skip: not coherent enough",
        model: "openai/gpt-4o-mini",
        finishReason: "stop",
        rawProviderName: "openrouter",
      })),
      vaultRoot: tmp,
      cluster: cluster(),
    });

    expect(proposal).toBeNull();
  });
});

function fakeLLM(chat: LLMProvider["chat"]): LLMProvider {
  return {
    providerName: "openrouter",
    modelName: "openai/gpt-4o-mini",
    chat,
  };
}

function cluster(): ThreadCluster {
  return {
    observations: [
      {
        relPath: "raw/2026-05-26/codex-a.md",
        created: "2026-05-26",
        entities: ["wiki/projects/memory-fort.md"],
        source: "codex",
        title: "Settings UI",
        snippet: "Provider settings became editable.",
      },
      {
        relPath: "raw/2026-05-27/codex-b.md",
        created: "2026-05-27",
        entities: ["wiki/projects/memory-fort.md"],
        source: "codex",
        title: "Secret handling",
        snippet: "Secrets stayed in env vars.",
      },
      {
        relPath: "raw/2026-05-28/codex-c.md",
        created: "2026-05-28",
        entities: ["wiki/projects/memory-fort.md"],
        source: "codex",
        title: "Validation",
        snippet: "Tests covered safe config patches.",
      },
    ],
    sharedEntities: ["wiki/projects/memory-fort.md"],
    timeRange: { start: "2026-05-26", end: "2026-05-28" },
    cohesionScore: 1,
  };
}
