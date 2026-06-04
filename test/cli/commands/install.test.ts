import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../../../src/cli/commands/install.js";
import type { VerifyResult } from "../../../src/cli/commands/verify.js";

describe("runInstall", () => {
  let tmp: string;
  let origMem: string | undefined;
  let origClaudeDesktop: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "install-command-"));
    origMem = process.env["MEMORY_ROOT"];
    origClaudeDesktop = process.env["MEMORY_CLAUDE_DESKTOP_DIR"];
    process.env["MEMORY_ROOT"] = join(tmp, ".memory");
    process.env["MEMORY_CLAUDE_DESKTOP_DIR"] = join(tmp, "Claude");
    await mkdir(join(tmp, ".memory"), { recursive: true });
    await writeFile(join(tmp, ".memory", "log.md"), "");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    if (origClaudeDesktop === undefined) delete process.env["MEMORY_CLAUDE_DESKTOP_DIR"];
    else process.env["MEMORY_CLAUDE_DESKTOP_DIR"] = origClaudeDesktop;
    await rm(tmp, { recursive: true, force: true });
  });

  it("runs verify after a successful install", async () => {
    let verifyCalls = 0;

    await runInstall("claude-desktop", {
      verifyFn: async () => {
        verifyCalls += 1;
        return verifyReport();
      },
    });

    expect(verifyCalls).toBe(1);
    expect(logSpy.mock.calls.flat().join("\n")).toContain("memory verify");
  });

  it("--dry-run reports install paths without writing client config", async () => {
    const writes: string[] = [];

    await runInstall("claude-desktop", {
      dryRun: true,
      stdout: captureStdout(writes, false),
      verifyFn: async () => verifyReport(),
    });

    expect(writes.join("")).toContain("memory install claude-desktop will write");
    expect(existsSync(join(tmp, "Claude", "claude_desktop_config.json"))).toBe(false);
  });

  it("prompts before install writes when stdout is a TTY", async () => {
    let promptCalls = 0;

    await runInstall("claude-desktop", {
      stdout: captureStdout([], true),
      confirm: async () => {
        promptCalls += 1;
        return true;
      },
      noVerify: true,
    });

    expect(promptCalls).toBe(1);
    expect(existsSync(join(tmp, "Claude", "claude_desktop_config.json"))).toBe(true);
  });

  it("--yes skips the install prompt", async () => {
    let promptCalls = 0;

    await runInstall("claude-desktop", {
      yes: true,
      stdout: captureStdout([], true),
      confirm: async () => {
        promptCalls += 1;
        return false;
      },
      noVerify: true,
    });

    expect(promptCalls).toBe(0);
    expect(existsSync(join(tmp, "Claude", "claude_desktop_config.json"))).toBe(true);
  });

  it("skips post-install verify when disabled", async () => {
    let verifyCalls = 0;

    await runInstall("claude-desktop", {
      noVerify: true,
      verifyFn: async () => {
        verifyCalls += 1;
        return verifyReport();
      },
    });

    expect(verifyCalls).toBe(0);
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
