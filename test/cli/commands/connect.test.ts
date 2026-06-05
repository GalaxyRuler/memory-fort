import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import { formatConnectResult, runConnect } from "../../../src/cli/commands/connect.js";
import type { VerifyResult } from "../../../src/cli/commands/verify.js";

describe("runConnect", () => {
  let tmp: string;
  let memDir: string;
  let repoDir: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "connect-"));
    memDir = join(tmp, ".memory");
    repoDir = join(tmp, "repo");
    await mkdir(join(repoDir, "dist", "hooks"), { recursive: true });
    await writeFile(join(repoDir, "package.json"), "{}");
    for (const hook of [
      "session-start",
      "prompt-submit",
      "post-tool-use",
      "pre-compact",
      "session-end",
      "mcp-server",
    ]) {
      await writeFile(join(repoDir, "dist", "hooks", `${hook}.mjs`), "// stub\n");
    }
    origEnv = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      MEMORY_REPO_DIR: process.env["MEMORY_REPO_DIR"],
      MEMORY_CLAUDE_DIR: process.env["MEMORY_CLAUDE_DIR"],
      MEMORY_CLAUDE_DESKTOP_DIR: process.env["MEMORY_CLAUDE_DESKTOP_DIR"],
      MEMORY_CODEX_DIR: process.env["MEMORY_CODEX_DIR"],
      MEMORY_ANTIGRAVITY_DIR: process.env["MEMORY_ANTIGRAVITY_DIR"],
      MEMORY_HERMES_DIR: process.env["MEMORY_HERMES_DIR"],
      MEMORY_PI_DIR: process.env["MEMORY_PI_DIR"],
      MEMORY_OPENCLAW_DIR: process.env["MEMORY_OPENCLAW_DIR"],
      MEMORY_VSCODE_USER_DIR: process.env["MEMORY_VSCODE_USER_DIR"],
    };
    process.env["MEMORY_ROOT"] = memDir;
    process.env["MEMORY_REPO_DIR"] = repoDir;
    process.env["MEMORY_CLAUDE_DIR"] = join(tmp, ".claude");
    process.env["MEMORY_CLAUDE_DESKTOP_DIR"] = join(tmp, "Claude");
    process.env["MEMORY_CODEX_DIR"] = join(tmp, ".codex");
    process.env["MEMORY_ANTIGRAVITY_DIR"] = join(tmp, ".gemini", "antigravity");
    process.env["MEMORY_HERMES_DIR"] = join(tmp, ".hermes");
    process.env["MEMORY_PI_DIR"] = join(tmp, ".pi");
    process.env["MEMORY_OPENCLAW_DIR"] = join(tmp, ".openclaw");
    process.env["MEMORY_VSCODE_USER_DIR"] = join(tmp, "Code", "User");
    await runInit({ sourceRepoDir: process.cwd() });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(origEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("runs all installers and reports partial failures as warnings", async () => {
    const result = await runConnect({ all: true, vscodeInstalled: false });
    expect(result.exitCode).toBe(0);
    expect(result.clients.map((client) => client.client)).toEqual([
      "claude-code",
      "claude-desktop",
      "codex",
      "antigravity",
      "antigravity-ide",
      "hermes",
      "pi",
      "openclaw",
      "vscode",
    ]);
    expect(result.clients.find((client) => client.client === "vscode")!.ok).toBe(false);
    expect(formatConnectResult(result)).toContain("antigravity-ide");
  });

  it("runs one selected client", async () => {
    const extensionDir = join(tmp, "extensions");
    const result = await runConnect({
      client: "vscode",
      vscodeInstalled: true,
      vscodeExtensionDir: extensionDir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.clients).toHaveLength(1);
    expect(result.clients[0]!.client).toBe("vscode");
    expect(result.clients[0]!.ok).toBe(true);
    expect(existsSync(join(extensionDir, "memory-fort.memory"))).toBe(true);
  });

  it("--dry-run reports connect paths without writing client config", async () => {
    const writes: string[] = [];
    const result = await runConnect({
      client: "codex",
      dryRun: true,
      stdout: captureStdout(writes, false),
      verifyFn: async () => verifyReport(),
    });

    expect(result.exitCode).toBe(0);
    expect(writes.join("")).toContain("memory connect will write");
    expect(existsSync(join(process.env["MEMORY_CODEX_DIR"]!, "config.toml"))).toBe(false);
  });

  it("prompts before connect writes when stdout is a TTY", async () => {
    let promptCalls = 0;
    const result = await runConnect({
      client: "codex",
      stdout: captureStdout([], true),
      confirm: async () => {
        promptCalls += 1;
        return true;
      },
      noVerify: true,
    });

    expect(promptCalls).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(process.env["MEMORY_CODEX_DIR"]!, "config.toml"))).toBe(true);
  });

  it("--yes skips the connect prompt", async () => {
    let promptCalls = 0;
    const result = await runConnect({
      client: "codex",
      yes: true,
      stdout: captureStdout([], true),
      confirm: async () => {
        promptCalls += 1;
        return false;
      },
      noVerify: true,
    });

    expect(promptCalls).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(process.env["MEMORY_CODEX_DIR"]!, "config.toml"))).toBe(true);
  });

  it("passes workspace path to VS Code installer", async () => {
    const workspace = join(tmp, "workspace");
    const result = await runConnect({
      client: "vscode",
      workspace,
      vscodeInstalled: true,
    });
    expect(result.clients[0]!.detail).toContain(".vscode");
  });

  it("runs verify after a successful connect and appends the report", async () => {
    let verifyCalls = 0;
    const result = await runConnect({
      client: "vscode",
      vscodeInstalled: true,
      verifyFn: async () => {
        verifyCalls += 1;
        return verifyReport();
      },
    });

    expect(verifyCalls).toBe(1);
    expect(result.verify?.overallStatus).toBe("pass");
    expect(formatConnectResult(result)).toContain("memory verify");
  });

  it("skips post-connect verify when disabled", async () => {
    let verifyCalls = 0;
    const result = await runConnect({
      client: "vscode",
      vscodeInstalled: true,
      noVerify: true,
      verifyFn: async () => {
        verifyCalls += 1;
        return verifyReport();
      },
    });

    expect(verifyCalls).toBe(0);
    expect(result.verify).toBeUndefined();
  });
});

function verifyReport(): VerifyResult {
  return {
    startedAt: "2026-05-26T03:30:00.000Z",
    finishedAt: "2026-05-26T03:30:00.000Z",
    overallStatus: "pass",
    checks: [{ id: "vault.read-write", label: "vault read/write", status: "pass", durationMs: 1 }],
    passed: 1,
    failed: 0,
    warnings: 0,
    exitCode: 0,
  };
}

function captureStdout(writes: string[], isTTY: boolean) {
  return {
    isTTY,
    write(chunk: string | Uint8Array): boolean {
      writes.push(String(chunk));
      return true;
    },
  };
}
