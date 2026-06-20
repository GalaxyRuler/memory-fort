import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeDesktopConfigCheck,
  codexCaptureCheck,
  snifferClaudeDesktopCaptureCheck,
  snifferClaudeDesktopWatcherCheck,
  snifferVscodeCaptureCheck,
  snifferVscodeExtensionCheck,
  vscodeConfigCheck,
} from "../../../../src/cli/commands/verify/clients.js";

async function makeVault(configYaml: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mf-clients-"));
  await writeFile(join(root, "config.yaml"), configYaml, "utf-8");
  return root;
}

describe("client toggle short-circuits verify", () => {
  it("returns skip for a disabled client instead of running the capture check", async () => {
    const vaultRoot = await makeVault("clients:\n  codex: false\n");
    const result = await codexCaptureCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    expect(flat[0]?.status).toBe("skip");
  });

  it("runs normally when the client is enabled (not skip)", async () => {
    const vaultRoot = await makeVault("clients:\n  codex: true\n");
    const result = await codexCaptureCheck.run({ vaultRoot, now: () => new Date() } as never);
    const flat = Array.isArray(result) ? result : [result];
    expect(flat[0]?.status).not.toBe("skip");
  });

  it("skips every VS Code verify check when VS Code is disabled", async () => {
    const vaultRoot = await makeVault("clients:\n  vscode: false\n");
    for (const check of [vscodeConfigCheck, snifferVscodeExtensionCheck, snifferVscodeCaptureCheck]) {
      const result = await check.run({ vaultRoot, now: () => new Date() } as never);
      const flat = Array.isArray(result) ? result : [result];
      expect(flat[0]?.status).toBe("skip");
    }
  });

  it("skips every Claude Desktop verify check when Claude Desktop is disabled", async () => {
    const vaultRoot = await makeVault("clients:\n  claude-desktop: false\n");
    for (const check of [claudeDesktopConfigCheck, snifferClaudeDesktopWatcherCheck, snifferClaudeDesktopCaptureCheck]) {
      const result = await check.run({ vaultRoot, now: () => new Date() } as never);
      const flat = Array.isArray(result) ? result : [result];
      expect(flat[0]?.status).toBe("skip");
    }
  });
});
