import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcedureCluster } from "../../src/consolidate/procedure-detect.js";
import { parseProcedureProposal, proposeProcedure, userPrompt } from "../../src/llm/procedure-propose.js";
import type { LLMProvider } from "../../src/llm/types.js";

describe("proposeProcedure", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "procedure-propose-"));
    await mkdir(join(tmp, "wiki"), { recursive: true });
    await writeMarkdown(tmp, "wiki/projects/memory-fort.md");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("calls the LLM with the procedure prompt and parses a valid response", async () => {
    const chat = vi.fn(async () => ({
      content: [
        "title: Deploy dashboard to VPS",
        "summary: |",
        "  Build and deploy the Memory Fort dashboard bundle to the VPS.",
        "preconditions:",
        "  - VPS SSH access is available",
        "steps:",
        "  - description: Build the Node dashboard bundle",
        "    command: npm run build",
        "  - description: Copy the server bundle to the VPS",
        "    command: scp dist/dashboard/server.mjs root@srv:/root/memory-system/services/dashboard-bundle.mjs",
        "verification:",
        "  - curl /memory/api/health returns ok",
        "failure_cases:",
        "  - condition: Missing dependency on VPS",
        "    remedy: Install the package in /root/memory-system/services",
        "tags:",
        "  - dashboard",
        "  - vps",
        "proposed_slug: deploy-dashboard-to-vps",
      ].join("\n"),
      model: "openai/gpt-4o-mini",
      finishReason: "stop" as const,
      rawProviderName: "openrouter",
    }));

    const result = await proposeProcedure({
      llm: fakeLLM(chat),
      vaultRoot: tmp,
      cluster: cluster(),
    });

    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]?.[0].messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("preconditions"),
    });
    const system = chat.mock.calls[0]?.[0].messages[0]?.content ?? "";
    expect(system).toContain("Existing wiki pages you may reference");
    expect(system).toContain("wiki/projects/memory-fort.md");
    expect(system).toContain("Real memory CLI commands");
    expect(system).toContain("verify");
    expect(promptGuardSection(system)).toMatchInlineSnapshot(`
      "Free-form field guardrails:
      Never put wiki/<category>/<slug> or raw/<date>/<file> path strings into free-form fields (summary, preconditions, steps[].description, verification, failure_cases). Those fields are human-readable prose. The wiki path list applies to relations only.
      Wrong free-form bullet: - wiki/procedures/example-procedure-page.md
      Correct free-form bullet: - Confirm the dashboard health endpoint after copying the bundle."
    `);
    expect(chat.mock.calls[0]?.[0].messages[1]?.content).toContain("Command signature: scp, ssh, curl");
    expect(chat.mock.calls[0]?.[0].messages[1]?.content).toContain("[1] 2026-05-26");
    expect(result.ok).toBe(true);
    expect(result.ok ? result.proposal : null).toEqual({
      title: "Deploy dashboard to VPS",
      summary: "Build and deploy the Memory Fort dashboard bundle to the VPS.",
      preconditions: ["VPS SSH access is available"],
      steps: [
        { description: "Build the Node dashboard bundle", command: "npm run build" },
        {
          description: "Copy the server bundle to the VPS",
          command: "scp dist/dashboard/server.mjs root@srv:/root/memory-system/services/dashboard-bundle.mjs",
        },
      ],
      verification: ["curl /memory/api/health returns ok"],
      failureCases: [
        {
          condition: "Missing dependency on VPS",
          remedy: "Install the package in /root/memory-system/services",
        },
      ],
      tags: ["dashboard", "vps"],
      proposedSlug: "deploy-dashboard-to-vps",
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
    expect(audit).toContain("auto-procedural-extract");
    expect(audit).toContain("| references_stripped |");
  });

  it("drops invented commands before returning and audits samples", async () => {
    const result = await proposeProcedure({
      llm: fakeLLM(async () => ({
        content: [
          "title: Perform daily skill review",
          "summary: Review skill notes.",
          "preconditions:",
          "  - Codex home exists",
          "steps:",
          "  - description: Run the invented helper",
          "    command: run-automation daily-personal-skill-review",
          "  - description: Verify memory health",
          "    command: memory verify --offline",
          "verification:",
          "  - The report is clean",
          "failure_cases: []",
          "tags:",
          "  - skills",
          "proposed_slug: perform-daily-skill-review",
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
    expect(proposal?.steps).toEqual([
      { description: "Run the invented helper" },
      { description: "Verify memory health", command: "memory verify --offline" },
    ]);
    expect(proposal?.grounding).toMatchObject({
      originalReferenceCount: 2,
      strippedReferenceCount: 1,
      strippedSamples: ["run-automation daily-personal-skill-review"],
    });
    const audit = await readFile(join(tmp, "wiki", ".audit", `llm-${new Date().toISOString().slice(0, 10)}.md`), "utf-8");
    expect(audit).toContain("run-automation daily-personal-skill-review");
    expect(audit).toContain("| 1 |");
  });

  it("strips prose path leaks from procedure fields and audits the leak count", async () => {
    const result = await proposeProcedure({
      llm: fakeLLM(async () => ({
        content: [
          "title: Deploy dashboard to VPS",
          "summary: |",
          "  Build and deploy the dashboard bundle.",
          "  wiki/projects/memory-fort.md",
          "preconditions:",
          "  - wiki/projects/memory-fort.md",
          "  - VPS SSH access is available",
          "steps:",
          "  - description: wiki/procedures/deploy-dashboard.md",
          "    command: npm run build",
          "  - description: Copy the server bundle to the VPS",
          "    command: scp dist/dashboard/server.mjs root@srv:/root/memory-system/services/dashboard-bundle.mjs",
          "verification:",
          "  - raw/2026-05-28/codex-session.md",
          "  - curl /memory/api/health returns ok",
          "failure_cases:",
          "  - condition: wiki/references/missing-dependency.md",
          "    remedy: Install the package on the VPS",
          "  - condition: Dashboard service is down",
          "    remedy: wiki/procedures/restart-service.md",
          "tags:",
          "  - dashboard",
          "proposed_slug: deploy-dashboard-to-vps",
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
    expect(proposal?.summary).toBe("Build and deploy the dashboard bundle.");
    expect(proposal?.preconditions).toEqual(["VPS SSH access is available"]);
    expect(proposal?.steps).toEqual([
      {
        description: "Copy the server bundle to the VPS",
        command: "scp dist/dashboard/server.mjs root@srv:/root/memory-system/services/dashboard-bundle.mjs",
      },
    ]);
    expect(proposal?.verification).toEqual(["curl /memory/api/health returns ok"]);
    expect(proposal?.failureCases).toEqual([]);
    expect(proposal?.grounding).toMatchObject({
      prosePathLeaksCount: 6,
      prosePathLeakSamples: [
        "wiki/projects/memory-fort.md",
        "wiki/projects/memory-fort.md",
        "wiki/procedures/deploy-dashboard.md",
      ],
    });
    const audit = await readFile(join(tmp, "wiki", ".audit", `llm-${new Date().toISOString().slice(0, 10)}.md`), "utf-8");
    expect(audit).toContain("| prose_path_leaks |");
    expect(audit).toContain("wiki/procedures/deploy-dashboard.md");
  });

  it("returns null for malformed responses", async () => {
    const result = await proposeProcedure({
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

  it("returns a specific reason for skip responses", async () => {
    const result = await proposeProcedure({
      llm: fakeLLM(async () => ({
        content: "skip: shared commands are coincidental",
        model: "openai/gpt-4o-mini",
        finishReason: "stop",
        rawProviderName: "openrouter",
      })),
      vaultRoot: tmp,
      cluster: cluster(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "model skipped: shared commands are coincidental",
      promptHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      responseHash: expect.stringMatching(/^[a-f0-9]{16}$/),
    });
  });

  it("parseProcedureProposal returns specific rejection reasons", () => {
    expect(parseProcedureProposal("")).toEqual({ ok: false, reason: "empty content" });
    expect(parseProcedureProposal("title: Valid Procedure Title\nsummary: nope\nproposed_slug: valid-procedure-title")).toEqual({
      ok: false,
      reason: "steps array empty",
    });
    expect(parseProcedureProposal("title: Valid Procedure Title\nsummary: nope")).toEqual({
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

describe("userPrompt budget", () => {
  // Regression: a 30-day scan put hundreds of observations in one cluster,
  // producing a 136k-token prompt against gpt-4o-mini's 128k context.
  it("caps an oversized cluster under the prompt budget and notes the omission", () => {
    const base = cluster();
    const observations = Array.from({ length: 500 }, (_, i) => ({
      ...base.observations[0]!,
      relPath: `raw/2026-05-${String((i % 28) + 1).padStart(2, "0")}/codex-${i}.md`,
      created: `2026-05-${String((i % 28) + 1).padStart(2, "0")}`,
      session: `s${i}`,
      title: `Deploy run ${i}`,
      body: "x".repeat(5_000),
    }));
    const prompt = userPrompt({ ...base, observations, distinctSessions: 500 });

    expect(prompt.length).toBeLessThan(110_000);
    expect(prompt).toContain("Cluster size: 500 observations");
    expect(prompt).toContain("most recent");
    expect(prompt).toContain("omitted for prompt budget");
    // Observation count actually included is bounded
    const included = prompt.match(/^\[\d+\]/gm) ?? [];
    expect(included.length).toBeLessThanOrEqual(40);
    expect(included.length).toBeGreaterThan(0);
  });

  it("includes all observations and no omission note for small clusters", () => {
    const prompt = userPrompt(cluster());
    expect(prompt).not.toContain("omitted for prompt budget");
    expect(prompt).toContain("[1] 2026-05-26");
    expect(prompt).toContain("[2] 2026-05-27");
  });
});

function cluster(): ProcedureCluster {
  return {
    observations: [
      {
        relPath: "raw/2026-05-26/codex-a.md",
        relations: { mentions: [{ target: "wiki/projects/memory-fort.md" }] },
        created: "2026-05-26",
        session: "a",
        source: "codex",
        title: "Deploy dashboard",
        body: "$ scp dist/dashboard/server.mjs root@srv:/root/server.mjs\n$ ssh root@srv restart\n$ curl health",
      },
      {
        relPath: "raw/2026-05-27/codex-b.md",
        relations: { mentions: [{ target: "wiki/projects/memory-fort.md" }] },
        created: "2026-05-27",
        session: "b",
        source: "codex",
        title: "Deploy again",
        body: "$ scp dist/dashboard/server.mjs root@srv:/root/server.mjs\n$ ssh root@srv restart\n$ curl health",
      },
    ],
    signature: ["scp", "ssh", "curl"],
    distinctSessions: 2,
    cohesionScore: 1,
    hasSuccessfulOutcome: true,
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
