import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadCluster } from "../../src/consolidate/thread-cluster.js";
import { parseThreadProposal, proposeThread } from "../../src/llm/thread-propose.js";
import type { LLMProvider } from "../../src/llm/types.js";

describe("proposeThread", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "thread-propose-"));
    await mkdir(join(tmp, "wiki"), { recursive: true });
    await writeMarkdown(tmp, "wiki/decisions/settings-ui.md");
    await writeMarkdown(tmp, "wiki/lessons/env-secrets.md");
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
        "  - Provider settings became editable while secrets stayed in env vars.",
        "key_lessons:",
        "  - Env-var-only secrets pair well with dashboard-visible non-secret config.",
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

    const result = await proposeThread({ llm, vaultRoot: tmp, cluster: cluster() });

    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]?.[0].messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Output exactly this shape"),
    });
    const system = chat.mock.calls[0]?.[0].messages[0]?.content ?? "";
    expect(system).toContain("Existing wiki pages you may reference");
    expect(system).toContain("wiki/decisions/settings-ui.md");
    expect(promptGuardSection(system)).toMatchInlineSnapshot(`
      "Free-form field guardrails:
      Never put wiki/<category>/<slug> or raw/<date>/<file> path strings into free-form fields (summary, key_decisions, key_lessons, open_questions). Those fields are human-readable prose. The wiki path list applies to relations only.
      Wrong free-form bullet: - wiki/decisions/example-decision-page.md
      Correct free-form bullet: - Chose the dashboard validation workflow after comparing the CLI-only option."
    `);
    expect(chat.mock.calls[0]?.[0].messages[1]?.content).toContain("Cluster: 3 observations");
    expect(result.ok).toBe(true);
    expect(result.ok ? result.proposal : null).toEqual({
      title: "Memory Fort Settings UI",
      summary: "A short arc about making provider settings editable.\nIt preserved env-var-only secrets while adding operator controls.",
      keyDecisions: ["Provider settings became editable while secrets stayed in env vars."],
      keyLessons: ["Env-var-only secrets pair well with dashboard-visible non-secret config."],
      openQuestions: ["Should proposal review get a dashboard surface?"],
      proposedSlug: "memory-fort-settings-ui",
      grounding: {
        originalReferenceCount: 2,
        strippedReferenceCount: 0,
        stripReasons: [],
        strippedSamples: [],
        prosePathLeaksCount: 0,
        prosePathLeakSamples: [],
      },
    });

    const audit = await readFile(join(tmp, "wiki", ".audit", `llm-${new Date().toISOString().slice(0, 10)}.md`), "utf-8");
    expect(audit).toContain("auto-thread-propose");
    expect(audit).toContain("| references_stripped |");
  });

  it("strips path strings from thread prose fields before returning and audits samples", async () => {
    const result = await proposeThread({
      llm: fakeLLM(async () => ({
        content: [
          "title: Memory Fort Settings UI",
          "summary: |",
          "  A short arc about making provider settings editable.",
          "key_decisions:",
          "  - wiki/decisions/settings-ui.md",
          "  - wiki/decisions/invented-path.md",
          "key_lessons:",
          "  - wiki/lessons/missing-lesson.md",
          "open_questions: []",
          "proposed_slug: memory-fort-settings-ui",
        ].join("\n"),
        model: "openai/gpt-4o-mini",
        finishReason: "stop",
        rawProviderName: "openrouter",
      })),
      vaultRoot: tmp,
      cluster: cluster(),
    });

    expect(result.ok).toBe(true);
    const proposal = result.ok ? result.proposal : null;
    expect(proposal?.keyDecisions).toEqual([]);
    expect(proposal?.keyLessons).toEqual([]);
    expect(proposal?.grounding).toMatchObject({
      originalReferenceCount: 3,
      strippedReferenceCount: 0,
      strippedSamples: [],
      prosePathLeaksCount: 3,
      prosePathLeakSamples: [
        "wiki/decisions/settings-ui.md",
        "wiki/decisions/invented-path.md",
        "wiki/lessons/missing-lesson.md",
      ],
    });
    const audit = await readFile(join(tmp, "wiki", ".audit", `llm-${new Date().toISOString().slice(0, 10)}.md`), "utf-8");
    expect(audit).toContain("wiki/decisions/invented-path.md");
    expect(audit).toContain("| 3 |");
  });

  it("strips prose path leaks from thread fields and audits the leak count", async () => {
    const result = await proposeThread({
      llm: fakeLLM(async () => ({
        content: [
          "title: Memory Fort Settings UI",
          "summary: |",
          "  Provider settings became safer.",
          "  wiki/projects/agentmemory.md",
          "key_decisions:",
          "  - wiki/decisions/settings-ui.md",
          "  - Keep editable settings separate from secrets.",
          "key_lessons:",
          "  - wiki/lessons/env-secrets.md",
          "open_questions:",
          "  - raw/2026-05-28/codex-c.md",
          "  - Should review move into the dashboard?",
          "proposed_slug: memory-fort-settings-ui",
        ].join("\n"),
        model: "openai/gpt-4o-mini",
        finishReason: "stop",
        rawProviderName: "openrouter",
      })),
      vaultRoot: tmp,
      cluster: cluster(),
    });

    expect(result.ok).toBe(true);
    const proposal = result.ok ? result.proposal : null;
    expect(proposal?.summary).toBe("Provider settings became safer.");
    expect(proposal?.keyDecisions).toEqual(["Keep editable settings separate from secrets."]);
    expect(proposal?.keyLessons).toEqual([]);
    expect(proposal?.openQuestions).toEqual(["Should review move into the dashboard?"]);
    expect(proposal?.grounding).toMatchObject({
      prosePathLeaksCount: 4,
      prosePathLeakSamples: [
        "wiki/projects/agentmemory.md",
        "wiki/decisions/settings-ui.md",
        "wiki/lessons/env-secrets.md",
      ],
    });
    const audit = await readFile(join(tmp, "wiki", ".audit", `llm-${new Date().toISOString().slice(0, 10)}.md`), "utf-8");
    expect(audit).toContain("| prose_path_leaks |");
    expect(audit).toContain("wiki/projects/agentmemory.md");
  });

  it("returns null for malformed YAML responses without throwing", async () => {
    const result = await proposeThread({
      llm: fakeLLM(async () => ({
        content: "title: [not valid",
        model: "openai/gpt-4o-mini",
        finishReason: "stop",
        rawProviderName: "openrouter",
      })),
      vaultRoot: tmp,
      cluster: cluster(),
    });

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("yaml parse error:") });
  });

  it("returns a specific reason when the model elects to skip the cluster", async () => {
    const result = await proposeThread({
      llm: fakeLLM(async () => ({
        content: "skip: not coherent enough",
        model: "openai/gpt-4o-mini",
        finishReason: "stop",
        rawProviderName: "openrouter",
      })),
      vaultRoot: tmp,
      cluster: cluster(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "model skipped: not coherent enough",
      promptHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      responseHash: expect.stringMatching(/^[a-f0-9]{16}$/),
    });
  });

  it("parseThreadProposal returns specific rejection reasons", () => {
    expect(parseThreadProposal("")).toEqual({ ok: false, reason: "empty content" });
    expect(parseThreadProposal("title: Short\nsummary: nope\nproposed_slug: nope")).toEqual({
      ok: false,
      reason: "title length out of bounds (got 5, expected 10-80)",
    });
    expect(parseThreadProposal("title: Valid Thread Title\nsummary: nope")).toEqual({
      ok: false,
      reason: "missing required field: proposed_slug",
    });
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
        relations: { mentions: [{ target: "wiki/decisions/settings-ui.md" }] },
        created: "2026-05-26",
        entities: ["wiki/projects/memory-fort.md"],
        source: "codex",
        title: "Settings UI",
        snippet: "Provider settings became editable.",
      },
      {
        relPath: "raw/2026-05-27/codex-b.md",
        relations: { mentions: [{ target: "wiki/lessons/env-secrets.md" }] },
        created: "2026-05-27",
        entities: ["wiki/projects/memory-fort.md"],
        source: "codex",
        title: "Secret handling",
        snippet: "Secrets stayed in env vars.",
      },
      {
        relPath: "raw/2026-05-28/codex-c.md",
        relations: { mentions: [{ target: "wiki/decisions/missing.md" }] },
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

async function writeMarkdown(root: string, relPath: string): Promise<void> {
  const fullPath = join(root, ...relPath.split("/"));
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, "---\ntitle: Fixture\n---\n\nBody.\n", "utf-8");
}

function promptGuardSection(prompt: string): string {
  const match = /Free-form field guardrails:[\s\S]*?Correct free-form bullet: .*/.exec(prompt);
  return match?.[0] ?? "";
}
