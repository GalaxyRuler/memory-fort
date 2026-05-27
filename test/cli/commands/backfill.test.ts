import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackfill } from "../../../src/cli/commands/backfill.js";
import type { ConsolidateResult } from "../../../src/consolidate/runner.js";
import { runInit } from "../../../src/cli/commands/init.js";
import { parseFrontmatter } from "../../../src/storage/frontmatter.js";

describe("runBackfill", () => {
  let tmp: string;
  let memoryDir: string;
  let claudeProjectsDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "backfill-"));
    memoryDir = join(tmp, ".memory");
    claudeProjectsDir = join(tmp, ".claude", "projects");
    originalEnv = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      MEMORY_CLAUDE_PROJECTS_DIR: process.env["MEMORY_CLAUDE_PROJECTS_DIR"],
    };
    process.env["MEMORY_ROOT"] = memoryDir;
    process.env["MEMORY_CLAUDE_PROJECTS_DIR"] = claudeProjectsDir;
    await runInit({ sourceRepoDir: process.cwd() });
    await writeClaudeSession("session-a", "2026-05-24T10:00:00.000Z", "hello");
  });

  afterEach(async () => {
    restoreEnv("MEMORY_ROOT");
    restoreEnv("MEMORY_CLAUDE_PROJECTS_DIR");
    await rm(tmp, { recursive: true, force: true });
  });

  it("plans Claude Code imports without writing raw files", async () => {
    const result = await runBackfill({
      from: "claude-code",
      since: "2026-05-22",
      plan: true,
      now: new Date("2026-05-26T12:00:00.000Z"),
    });

    expect(result.report).toContain("Memory backfill plan");
    expect(result.report).toContain("claude-code: 1 session");
    expect(result.report).toContain("raw/2026-05-24/claude-code-session-a.md");
    expect(existsSync(join(memoryDir, "raw", "2026-05-24", "claude-code-session-a.md"))).toBe(false);
  });

  it("applies backfill, writes an audit log, and is idempotent", async () => {
    const first = await runBackfill({
      from: "claude-code",
      since: "2026-05-22",
      now: new Date("2026-05-26T12:00:00.000Z"),
    });

    expect(first.report).toContain("Memory backfill apply");
    expect(first.report).toContain("written: 1");
    expect(first.auditLogPath).toBe(join(memoryDir, "wiki", ".audit", "backfill-2026-05-26T12-00-00-000Z.md"));
    expect(existsSync(join(memoryDir, "raw", "2026-05-24", "claude-code-session-a.md"))).toBe(true);
    const audit = await readFile(first.auditLogPath!, "utf-8");
    expect(audit).toContain("[write] raw/2026-05-24/claude-code-session-a.md");
    expect(parseFrontmatter(audit).frontmatter.source).toBe("backfill");

    const second = await runBackfill({
      from: "claude-code",
      since: "2026-05-22",
      now: new Date("2026-05-26T12:01:00.000Z"),
    });

    expect(second.report).toContain("written: 0");
    expect(second.report).toContain("skipped: 1");
  });

  it("can chain consolidation after an apply run", async () => {
    let consolidateCalls = 0;
    const result = await runBackfill({
      from: "claude-code",
      since: "2026-05-22",
      now: new Date("2026-05-26T12:00:00.000Z"),
      consolidateAfter: true,
      consolidateFn: async (opts) => {
        consolidateCalls += 1;
        expect(opts.plan).toBe(false);
        return consolidateResult();
      },
    });

    expect(consolidateCalls).toBe(1);
    expect(result.report).toContain("Memory consolidate apply");
  });

  it("rejects unknown clients", async () => {
    await expect(runBackfill({ from: "unknown" })).rejects.toThrow(/unknown sniffer/);
  });

  async function writeClaudeSession(sessionId: string, timestamp: string, prompt: string): Promise<void> {
    const projectDir = join(claudeProjectsDir, "project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: "user",
        timestamp,
        sessionId,
        message: { role: "user", content: prompt },
      }) + "\n",
    );
  }

  function restoreEnv(key: "MEMORY_ROOT" | "MEMORY_CLAUDE_PROJECTS_DIR"): void {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  function consolidateResult(): ConsolidateResult {
    return {
      mode: "apply",
      plans: [],
      summary: {
        scanned: 1,
        proposed: 1,
        proposedEdges: 1,
        updated: 1,
        newEdges: 1,
      },
      auditLogPath: join(memoryDir, "wiki", ".audit", "consolidate-2026-05-26T12-00-00-000Z.md"),
    };
  }
});
