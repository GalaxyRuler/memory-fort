import { execFile as nodeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatProcedureProposeResult,
  runProcedurePromote,
  runProcedurePropose,
  runProcedureReject,
} from "../../../src/cli/commands/procedure.js";
import { parseFrontmatter } from "../../../src/storage/frontmatter.js";
import type { LLMProvider } from "../../../src/llm/types.js";
import { commitVaultChange as realCommitVaultChange } from "../../../src/sync/commit-vault-change.js";

const execFile = promisify(nodeExecFile);

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
    expect(result.referencesStripped).toBe(0);
    expect(result.proposals[0]).toMatchObject({
      slug: "deploy-dashboard-to-vps",
      relPath: "wiki/procedures-proposed/deploy-dashboard-to-vps.md",
      observationCount: 3,
      sessionCount: 3,
    });
    expect(existsSync(join(tmp, "wiki", "procedures-proposed", "deploy-dashboard-to-vps.md"))).toBe(false);
    expect(existsSync(result.auditLogPath)).toBe(true);
    expect(formatProcedureProposeResult(result)).toContain("Mode: plan");
    expect(formatProcedureProposeResult(result)).toContain("References stripped: 0 (avg 0.0 per proposal)");
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

  it("auto-promotes high-confidence procedure proposals when requested", async () => {
    for (let index = 4; index <= 5; index += 1) {
      await writeMarkdown(
        `raw/2026-05-2${index}/codex-${index}.md`,
        rawPage(`Deploy ${index}`, `session-${index}`, "$ scp dist/dashboard/server.mjs root@srv:/root/server.mjs\n$ ssh root@srv restart\n$ curl health\n"),
      );
    }

    const result = await runProcedurePropose({
      vaultRoot: tmp,
      apply: true,
      autoPromote: true,
      days: 30,
      maxProposals: 1,
      now: new Date("2026-05-28T12:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM("deploy-dashboard-to-vps"),
      env: {},
    });

    expect(result.written).toBe(1);
    expect(result.autoPromoted).toBe(1);
    expect(result.awaitingReview).toBe(0);
    expect(result.proposals[0]).toMatchObject({
      relPath: "wiki/procedures/deploy-dashboard-to-vps.md",
      autoPromoted: true,
      confidence: { level: "high", reasons: ["all signals clean"] },
    });
    expect(existsSync(join(tmp, "wiki", "procedures", "deploy-dashboard-to-vps.md"))).toBe(true);
    expect(existsSync(join(tmp, "wiki", "procedures-proposed", "deploy-dashboard-to-vps.md"))).toBe(false);
    expect(formatProcedureProposeResult(result)).toContain("Drafts auto-promoted: 1");
    expect(formatProcedureProposeResult(result)).toContain("Drafts awaiting review: 0");
    expect(await readFile(result.auditLogPath, "utf-8")).toContain("autoPromoted: true");
  });

  it("keeps proposals with stripped commands in review even with auto-promote enabled", async () => {
    for (let index = 4; index <= 5; index += 1) {
      await writeMarkdown(
        `raw/2026-05-2${index}/codex-${index}.md`,
        rawPage(`Deploy ${index}`, `session-${index}`, "$ scp dist/dashboard/server.mjs root@srv:/root/server.mjs\n$ ssh root@srv restart\n$ curl health\n"),
      );
    }

    const result = await runProcedurePropose({
      vaultRoot: tmp,
      apply: true,
      autoPromote: true,
      days: 30,
      maxProposals: 1,
      now: new Date("2026-05-28T12:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM("deploy-dashboard-to-vps", "run-automation daily-review"),
      env: {},
    });

    expect(result.autoPromoted).toBe(0);
    expect(result.awaitingReview).toBe(1);
    expect(result.proposals[0]).toMatchObject({
      relPath: "wiki/procedures-proposed/deploy-dashboard-to-vps.md",
      autoPromoted: false,
      confidence: {
        level: "low",
        reasons: ["strippedReferenceCount=1", "commandsStripped=1"],
      },
    });
    expect(existsSync(join(tmp, "wiki", "procedures-proposed", "deploy-dashboard-to-vps.md"))).toBe(true);
  });

  it("does not write invented commands to proposed procedure drafts", async () => {
    const result = await runProcedurePropose({
      vaultRoot: tmp,
      apply: true,
      days: 30,
      maxProposals: 1,
      now: new Date("2026-05-28T12:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM("deploy-dashboard-to-vps", "run-automation daily-review"),
      env: {},
    });

    expect(result.referencesStripped).toBe(1);
    const draft = await readFile(join(tmp, "wiki", "procedures-proposed", "deploy-dashboard-to-vps.md"), "utf-8");
    expect(draft).toContain("Build the bundle");
    expect(draft).not.toContain("run-automation daily-review");
    expect(await readFile(result.auditLogPath, "utf-8")).toContain("references stripped: 1 (avg 1.0 per proposal)");
  });

  it("skips malformed LLM proposals with parser reasons and writes the run audit", async () => {
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
    expect(result.skipped).toEqual([{
      clusterIndex: 0,
      reason: expect.stringContaining("yaml parse error:"),
    }]);
    expect(formatProcedureProposeResult(result)).toContain("cluster 0: yaml parse error:");
    expect(await readFile(result.auditLogPath, "utf-8")).toContain("yaml parse error:");
  });

  it("includes prompt and response hashes for skipped clusters when debug logging is enabled", async () => {
    const result = await runProcedurePropose({
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
            "title: Deploy dashboard to VPS",
            "summary: Missing proposed slug.",
            "steps:",
            "  - description: Build the bundle",
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
    expect(formatProcedureProposeResult(result)).toContain("hashes prompt=");
    expect(formatProcedureProposeResult(result)).toContain("response=");
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

    const commitVaultChange = vi.fn(async () => ({ kind: "committed" as const, commitSha: "abc1234" }));
    const promoted = await runProcedurePromote({ vaultRoot: tmp, slug: "deploy-dashboard-to-vps", commitVaultChange });
    const rejected = await runProcedureReject({ vaultRoot: tmp, slug: "reject-me", commitVaultChange });

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
    expect(commitVaultChange).toHaveBeenCalledWith({
      memoryRoot: tmp,
      paths: ["wiki/procedures-proposed/deploy-dashboard-to-vps.md", "wiki/procedures/deploy-dashboard-to-vps.md"],
      message: "promote procedure: deploy-dashboard-to-vps",
    });
    expect(commitVaultChange).toHaveBeenCalledWith({
      memoryRoot: tmp,
      paths: ["wiki/procedures-proposed/reject-me.md"],
      message: "reject procedure: reject-me",
    });
  });

  it("commits promoted and rejected procedure mutations and leaves their paths clean", async () => {
    await initGitRepo(tmp);
    await writeMarkdown(
      "wiki/procedures-proposed/deploy-sync-test.md",
      [
        "---",
        "type: procedures",
        "title: Deploy Sync Test",
        "created: 2026-05-28",
        "updated: 2026-05-28",
        "source: auto-procedural-extract",
        "lifecycle: proposed",
        "---",
        "",
        "# Deploy Sync Test",
        "",
        "Draft body.",
      ].join("\n"),
    );
    await writeMarkdown(
      "wiki/procedures-proposed/reject-procedure-sync-test.md",
      page("procedures", "Reject Procedure Sync Test", "Draft body."),
    );
    await git(["add", "--", "wiki/procedures-proposed/reject-procedure-sync-test.md"], tmp);
    await git(["commit", "-m", "seed tracked procedure draft"], tmp);
    const commitVaultChange = (opts: Parameters<typeof realCommitVaultChange>[0]) =>
      realCommitVaultChange({
        ...opts,
        scheduleAutoPush: async () => ({ scheduled: true, token: "unused" }),
      });

    const promoted = await runProcedurePromote({
      vaultRoot: tmp,
      slug: "deploy-sync-test",
      commitVaultChange,
    });
    const rejected = await runProcedureReject({
      vaultRoot: tmp,
      slug: "reject-procedure-sync-test",
      commitVaultChange,
    });

    await expect(git(["status", "--porcelain", "--", promoted.from, promoted.to, rejected.deleted], tmp)).resolves.toBe("");
    await expect(git(["log", "-1", "--pretty=%s"], tmp)).resolves.toBe("reject procedure: reject-procedure-sync-test");
  });

  async function writeMarkdown(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

async function initGitRepo(cwd: string): Promise<void> {
  await git(["init"], cwd);
  await git(["config", "user.name", "Test User"], cwd);
  await git(["config", "user.email", "test@example.com"], cwd);
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execFile("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

function fakeLLM(slug: string, firstCommand = "npm run build"): LLMProvider {
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
        `    command: ${firstCommand}`,
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
