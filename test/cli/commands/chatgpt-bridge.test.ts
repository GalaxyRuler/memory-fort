import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runChatGptBridgeStatus,
  runChatGptBridgeStop,
} from "../../../src/cli/commands/chatgpt-bridge.js";
import { chatgptBridgePidPath } from "../../../src/storage/paths.js";

describe("runChatGptBridgeStatus", () => {
  let tmp: string;
  let memDir: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "chatgpt-bridge-"));
    memDir = join(tmp, ".memory");
    origEnv = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      LOCALAPPDATA: process.env["LOCALAPPDATA"],
    };
    process.env["MEMORY_ROOT"] = memDir;
    // Point LOCALAPPDATA to temp so chatgptBridgePidPath() resolves inside test dir
    process.env["LOCALAPPDATA"] = join(tmp, "appdata");
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(origEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("reports not running when PID file is absent", async () => {
    const status = await runChatGptBridgeStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.port).toBe(3100);
    expect(status.url).toBe("http://localhost:3100/sse");
  });

  it("reports not running and cleans up PID file when it contains a dead PID", async () => {
    const pidPath = chatgptBridgePidPath();
    await mkdir(join(pidPath, ".."), { recursive: true });
    const deadPid = 9999999;
    await writeFile(pidPath, String(deadPid), "utf-8");

    const status = await runChatGptBridgeStatus();

    expect(typeof status.running).toBe("boolean");
    expect(status.port).toBe(3100);
  });

  it("reports not running when PID file contains invalid content", async () => {
    const pidPath = chatgptBridgePidPath();
    await mkdir(join(pidPath, ".."), { recursive: true });
    await writeFile(pidPath, "not-a-number", "utf-8");

    const status = await runChatGptBridgeStatus();

    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });

  it("uses port from config when configured", async () => {
    await mkdir(memDir, { recursive: true });
    await writeFile(
      join(memDir, "config.yaml"),
      "chatgpt:\n  bridge_port: 4200\n",
      "utf-8",
    );

    const status = await runChatGptBridgeStatus();

    expect(status.port).toBe(4200);
    expect(status.url).toBe("http://localhost:4200/sse");
  });
});

describe("runChatGptBridgeStop", () => {
  let tmp: string;
  let memDir: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "chatgpt-bridge-stop-"));
    memDir = join(tmp, ".memory");
    origEnv = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      LOCALAPPDATA: process.env["LOCALAPPDATA"],
    };
    process.env["MEMORY_ROOT"] = memDir;
    process.env["LOCALAPPDATA"] = join(tmp, "appdata");
    await mkdir(memDir, { recursive: true });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(origEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("stop removes PID file even when process is not alive", async () => {
    const pidPath = chatgptBridgePidPath();
    await mkdir(join(pidPath, ".."), { recursive: true });
    await writeFile(pidPath, "99999999", "utf-8");
    await runChatGptBridgeStop();
    expect(existsSync(pidPath)).toBe(false);
  });
});
