import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectInitTools,
  runInitOnboarding,
  type InitToolName,
} from "../../../src/cli/commands/init-onboarding.js";
import type { ConnectOptions, ConnectResult } from "../../../src/cli/commands/connect.js";

describe("init onboarding", () => {
  let tmp: string;
  let envBefore: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "init-onboarding-"));
    envBefore = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      MEMORY_REPO_DIR: process.env["MEMORY_REPO_DIR"],
    };
    process.env["MEMORY_REPO_DIR"] = process.cwd();
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("detects present tools over a fake filesystem", () => {
    const homeDir = join(tmp, "home");
    const appData = join(homeDir, "AppData", "Roaming");
    const present = new Set([
      join(homeDir, ".claude"),
      join(homeDir, ".codex"),
      join(homeDir, ".gemini", "antigravity"),
      join(appData, "Claude", "claude_desktop_config.json"),
      join(appData, "Code", "User"),
    ]);

    const tools = detectInitTools({
      homeDir,
      env: { APPDATA: appData },
      platform: "win32",
      fs: { existsSync: (path) => present.has(path) },
    });

    expect(tools).toEqual([
      "claude-code",
      "claude-desktop",
      "codex",
      "antigravity",
      "vscode",
    ]);
    expect(detectInitTools({
      homeDir,
      env: { APPDATA: appData },
      platform: "win32",
      fs: { existsSync: () => false },
    })).toEqual([]);
  });

  it("runs the four-question wizard, writes retrieval config, and wires selected tools", async () => {
    const vault = join(tmp, "vault");
    const answers = [vault, "Public User", "codex", "openai"];
    const questions: string[] = [];
    const connected: InitToolName[] = [];

    const result = await runInitOnboarding({
      sourceRepoDir: process.cwd(),
      stdout: captureStdout([], true),
      prompt: async (question) => {
        questions.push(question);
        return answers.shift() ?? "";
      },
      connectFn: async (opts) => {
        connected.push(opts.client as InitToolName);
        return connectResult(opts.client as InitToolName);
      },
    });

    expect(questions).toHaveLength(4);
    expect(result.vault).toBe(vault);
    expect(result.name).toBe("Public User");
    expect(result.retrieval).toBe("openai");
    expect(connected).toEqual(["codex"]);

    const config = await readFile(join(vault, "config.yaml"), "utf-8");
    expect(config).toContain("provider: openai");
    expect(config).toContain("model: text-embedding-3-small");
    expect(existsSync(join(vault, "schema.md"))).toBe(true);
  });

  it("--yes uses defaults with detected tools and no prompt", async () => {
    const vault = join(tmp, "vault");
    await mkdir(join(tmp, ".codex"), { recursive: true });
    const connected: InitToolName[] = [];
    let promptCalls = 0;

    const result = await runInitOnboarding({
      yes: true,
      vault,
      homeDir: tmp,
      env: {},
      sourceRepoDir: process.cwd(),
      stdout: captureStdout([], true),
      prompt: async () => {
        promptCalls += 1;
        return "";
      },
      connectFn: async (opts) => {
        connected.push(opts.client as InitToolName);
        return connectResult(opts.client as InitToolName);
      },
    });

    expect(promptCalls).toBe(0);
    expect(result.retrieval).toBe("lexical");
    expect(connected).toEqual(["codex"]);
    await expect(readFile(join(vault, "config.yaml"), "utf-8")).resolves.toContain("provider: lexical");
  });
});

function captureStdout(writes: string[], isTTY: boolean) {
  return {
    isTTY,
    write(chunk: string | Uint8Array): boolean {
      writes.push(String(chunk));
      return true;
    },
  };
}

function connectResult(client: InitToolName): ConnectResult {
  return {
    clients: [{ client: client as ConnectOptions["client"] & InitToolName, ok: true, detail: "installed" }],
    exitCode: 0,
  };
}
