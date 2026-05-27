import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcedureCluster } from "../../src/consolidate/procedure-detect.js";
import { proposeProcedure } from "../../src/llm/procedure-propose.js";
import type { LLMProvider } from "../../src/llm/types.js";

describe("proposeProcedure", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "procedure-propose-"));
    await mkdir(join(tmp, "wiki"), { recursive: true });
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

    const proposal = await proposeProcedure({
      llm: fakeLLM(chat),
      vaultRoot: tmp,
      cluster: cluster(),
    });

    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]?.[0].messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("preconditions"),
    });
    expect(chat.mock.calls[0]?.[0].messages[1]?.content).toContain("Command signature: scp, ssh, curl");
    expect(chat.mock.calls[0]?.[0].messages[1]?.content).toContain("[1] 2026-05-26");
    expect(proposal).toEqual({
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
    });

    const audit = await readFile(join(tmp, "wiki", ".audit", `llm-${new Date().toISOString().slice(0, 10)}.md`), "utf-8");
    expect(audit).toContain("auto-procedural-extract");
  });

  it("returns null for malformed responses", async () => {
    const proposal = await proposeProcedure({
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

  it("returns null for skip responses", async () => {
    const proposal = await proposeProcedure({
      llm: fakeLLM(async () => ({
        content: "skip: shared commands are coincidental",
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

function cluster(): ProcedureCluster {
  return {
    observations: [
      {
        relPath: "raw/2026-05-26/codex-a.md",
        created: "2026-05-26",
        session: "a",
        source: "codex",
        title: "Deploy dashboard",
        body: "$ scp dist/dashboard/server.mjs root@srv:/root/server.mjs\n$ ssh root@srv restart\n$ curl health",
      },
      {
        relPath: "raw/2026-05-27/codex-b.md",
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
