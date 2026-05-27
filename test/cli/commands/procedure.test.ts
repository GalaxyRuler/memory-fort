import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatProcedureProposeResult,
  runProcedurePromote,
  runProcedurePropose,
  runProcedureReject,
} from "../../../src/cli/commands/procedure.js";
import { parseFrontmatter } from "../../../src/storage/frontmatter.js";
import type { LLMProvider } from "../../../src/llm/types.js";

describe("procedure commands", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-procedure-"));
    for (let index = 1; index <= 3; index += 1) {
      await writeMarkdown(
        `raw/2026-05-2${index}/codex-${index}.md`,
        rawPage(`Deploy ${index}`, `session-${index}`, "$ scp dist/dashboard/server.mjs root@srv:/root/server.mjs\n$ ssh root@srv restart\n$ curl health\n"),
      );
    }
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("plans proposals without writing draft procedure pages", async () => {
    const result = await runProcedurePropose({
      vaultRoot: tmp,
      apply: false,
      days: 30,
      maxProposals: 1,
      now: new Date("2026-05-28T12:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM("deploy-dashboard-to-vps"),
      env: {},
    });

    expect(result.scanned).toBe(3);
    expect(result.clustered).toBe(1);
    expect(result.proposed).toBe(1);
    expect(result.written).toBe(0);
    expect(result.proposals[0]).toMatchObject({
      slug: "deploy-dashboard-to-vps",
      relPath: "wiki/procedures-proposed/deploy-dashboard-to-vps.md",
      observationCount: 3,
      sessionCount: 3,
    });
    expect(existsSync(join(tmp, "wiki", "procedures-proposed", "deploy-dashboard-to-vps.md"))).toBe(false);
    expect(existsSync(result.auditLogPath)).toBe(true);
    expect(formatProcedureProposeResult(result)).toContain("Mode: plan");
  });

  it("applies proposals to wiki/procedures-proposed and handles slug collisions", async () => {
    await writeMarkdown(
      "wiki/procedures-proposed/deploy-dashboard-to-vps.md",
      page("procedures", "Existing Procedure", "Already present."),
    );

    const result = await runProcedurePropose({
      vaultRoot: tmp,
      apply: true,
      days: 30,
      maxProposals: 1,
      now: new Date("2026-05-28T12:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM("deploy-dashboard-to-vps"),
      env: {},
    });

    expect(result.written).toBe(1);
    expect(result.proposals[0]?.slug).toBe("deploy-dashboard-to-vps-2");
    const draftPath = join(tmp, "wiki", "procedures-proposed", "deploy-dashboard-to-vps-2.md");
    const draft = parseFrontmatter(await readFile(draftPath, "utf-8"));
    expect(draft.frontmatter.lifecycle).toBe("proposed");
    expect(draft.frontmatter.source).toBe("auto-procedural-extract");
    expect(draft.frontmatter.cognitive_type).toBe("procedural");
    expect(draft.frontmatter.relations?.derived_from).toEqual([
      "raw/2026-05-21/codex-1.md",
      "raw/2026-05-22/codex-2.md",
      "raw/2026-05-23/codex-3.md",
    ]);
    expect(draft.body).toContain("## Preconditions");
    expect(draft.body).toContain("```bash");
    expect(existsSync(join(tmp, "wiki", "procedures", "deploy-dashboard-to-vps-2.md"))).toBe(false);
  });

  it("skips malformed LLM proposals and writes the run audit", async () => {
    const result = await runProcedurePropose({
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
    expect(result.skipped).toEqual([{ clusterIndex: 0, reason: "proposal skipped or malformed" }]);
    expect(await readFile(result.auditLogPath, "utf-8")).toContain("proposal skipped or malformed");
  });

  it("honors the MEMORY_LLM_DISABLED kill switch", async () => {
    await expect(runProcedurePropose({
      vaultRoot: tmp,
      apply: false,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM("deploy-dashboard-to-vps"),
      env: { MEMORY_LLM_DISABLED: "true" },
    })).rejects.toThrow("LLM access disabled by MEMORY_LLM_DISABLED=true");
  });

  it("promotes and rejects proposed procedure drafts", async () => {
    await writeMarkdown(
      "wiki/procedures-proposed/deploy-dashboard-to-vps.md",
      [
        "---",
        "type: procedures",
        "title: Deploy dashboard to VPS",
        "created: 2026-05-28",
        "updated: 2026-05-28",
        "source: auto-procedural-extract",
        "lifecycle: proposed",
        "---",
        "",
        "# Deploy dashboard to VPS",
        "",
        "Draft body.",
      ].join("\n"),
    );
    await writeMarkdown(
      "wiki/procedures-proposed/reject-me.md",
      page("procedures", "Reject Me", "Draft body."),
    );

    const promoted = await runProcedurePromote({ vaultRoot: tmp, slug: "deploy-dashboard-to-vps" });
    const rejected = await runProcedureReject({ vaultRoot: tmp, slug: "reject-me" });

    expect(promoted).toEqual({
      from: "wiki/procedures-proposed/deploy-dashboard-to-vps.md",
      to: "wiki/procedures/deploy-dashboard-to-vps.md",
    });
    expect(rejected).toEqual({ deleted: "wiki/procedures-proposed/reject-me.md" });
    expect(existsSync(join(tmp, promoted.from))).toBe(false);
    expect(existsSync(join(tmp, rejected.deleted))).toBe(false);

    const canonical = parseFrontmatter(await readFile(join(tmp, promoted.to), "utf-8"));
    expect(canonical.frontmatter.lifecycle).toBe("consolidated");
    expect(canonical.frontmatter.source).toBe("auto-procedural-extract-validated");
    expect(canonical.body).toContain("Draft body.");
  });

  async function writeMarkdown(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function fakeLLM(slug: string): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async () => ({
      content: [
        "title: Deploy dashboard to VPS",
        "summary: |",
        "  Build and deploy the Memory Fort dashboard bundle to the VPS.",
        "preconditions:",
        "  - VPS SSH access is available",
        "steps:",
        "  - description: Build the bundle",
        "    command: npm run build",
        "  - description: Copy the server bundle",
        "    command: scp dist/dashboard/server.mjs root@srv:/root/memory-system/services/dashboard-bundle.mjs",
        "verification:",
        "  - curl /memory/api/health returns ok",
        "failure_cases:",
        "  - condition: Missing dependency",
        "    remedy: Install the package in /root/memory-system/services",
        "tags:",
        "  - dashboard",
        "  - vps",
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

function rawPage(title: string, session: string, body: string): string {
  return [
    "---",
    "type: raw-session",
    `title: ${title}`,
    "created: 2026-05-28",
    "updated: 2026-05-28",
    `session: ${session}`,
    "---",
    "",
    body,
  ].join("\n");
}
