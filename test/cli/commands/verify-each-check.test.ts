import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAutoPush } from "../../../src/cli/commands/verify/autopush.js";
import { checkClients } from "../../../src/cli/commands/verify/clients.js";
import { checkCompile } from "../../../src/cli/commands/verify/compile.js";
import { checkDashboard } from "../../../src/cli/commands/verify/dashboard.js";
import { checkGitRemote } from "../../../src/cli/commands/verify/git.js";
import { checkSearch } from "../../../src/cli/commands/verify/search.js";
import { checkVaultReadWrite } from "../../../src/cli/commands/verify/vault.js";

describe("verify checks", () => {
  let tmp: string;
  let origEnv: Record<string, string | undefined>;
  const now = () => new Date("2026-05-26T03:30:00.000Z");

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "verify-check-"));
    origEnv = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      MEMORY_CLAUDE_DIR: process.env["MEMORY_CLAUDE_DIR"],
      MEMORY_CODEX_DIR: process.env["MEMORY_CODEX_DIR"],
      MEMORY_ANTIGRAVITY_DIR: process.env["MEMORY_ANTIGRAVITY_DIR"],
      MEMORY_VSCODE_USER_DIR: process.env["MEMORY_VSCODE_USER_DIR"],
      MEMORY_CLAUDE_DESKTOP_DIR: process.env["MEMORY_CLAUDE_DESKTOP_DIR"],
    };
    process.env["MEMORY_ROOT"] = tmp;
    process.env["MEMORY_CLAUDE_DIR"] = join(tmp, ".claude");
    process.env["MEMORY_CODEX_DIR"] = join(tmp, ".codex");
    process.env["MEMORY_ANTIGRAVITY_DIR"] = join(tmp, ".gemini", "antigravity");
    process.env["MEMORY_VSCODE_USER_DIR"] = join(tmp, "Code", "User");
    process.env["MEMORY_CLAUDE_DESKTOP_DIR"] = join(tmp, "Claude");
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(origEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("vault read/write creates, reads, and deletes its temp file", async () => {
    const result = await checkVaultReadWrite({ vaultRoot: tmp, now });

    expect(result.status).toBe("pass");
    expect(existsSync(join(tmp, "raw", ".verify-1779766200000.tmp"))).toBe(false);
  });

  it("git remote check warns instead of executing in offline mode", async () => {
    let called = false;
    const result = await checkGitRemote({
      vaultRoot: tmp,
      offline: true,
      execFile: async () => {
        called = true;
      },
    });

    expect(result.status).toBe("warn");
    expect(result.label).toContain("skipped");
    expect(called).toBe(false);
  });

  it("dashboard check fails when /api/status does not return JSON", async () => {
    const result = await checkDashboard({
      dashboardUrl: "https://example.test/memory",
      fetchFn: async () =>
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    });

    expect(result.status).toBe("fail");
    expect(result.fix).toContain("dashboard");
  });

  it("search check passes when the pipeline returns at least one result", async () => {
    const result = await checkSearch({
      vaultRoot: tmp,
      searchFn: async () => ({
        query: "memory fort",
        results: [{ path: "wiki/projects/memory-fort.md" }],
        timings: { totalMs: 47 },
      }),
    });

    expect(result.status).toBe("pass");
    expect(result.label).toContain("returned 1 results in 47ms");
  });

  it("client checks catch enabled Claude Code with no recent capture as a warning", async () => {
    await mkdir(process.env["MEMORY_CLAUDE_DIR"]!, { recursive: true });
    await writeFile(
      join(process.env["MEMORY_CLAUDE_DIR"]!, "settings.json"),
      JSON.stringify({ enabledPlugins: { "memory@memory-local": true } }),
    );

    const results = await checkClients({ vaultRoot: tmp, now });

    expect(
      results.find((result) => result.id === "client.claude-code.enabled")?.status,
    ).toBe("pass");
    expect(
      results.find((result) => result.id === "client.claude-code.capture")?.status,
    ).toBe("warn");
  });

  it("auto-push check fails for errors in the last hour and warns for the last day", async () => {
    await writeFile(
      join(tmp, "errors.log"),
      [
        "[2026-05-26T03:00:00.000Z] auto-push schedule failed: ENOENT",
        "[2026-05-25T12:00:00.000Z] auto-push schedule failed: ENOENT",
      ].join("\n"),
    );

    const result = await checkAutoPush({ vaultRoot: tmp, now });

    expect(result.status).toBe("fail");
    expect(result.label).toContain("1 errors in last hour");
  });

  it("compile check passes when the dashboard status has a recent compile", async () => {
    const result = await checkCompile({
      vaultRoot: tmp,
      now,
      dashboardStatus: {
        lastCompile: {
          timestamp: "2026-05-22T00:00:00.000Z",
          line: "## [2026-05-22T00:00:00.000Z] compile | ok",
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.label).toContain("compile last ran 2026-05-22");
  });
});
