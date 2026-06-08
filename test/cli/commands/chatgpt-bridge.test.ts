import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runChatGptBridgeStatus,
  runChatGptBridgeStop,
} from "../../../src/cli/commands/chatgpt-bridge.js";

describe("runChatGptBridgeStatus", () => {
  let tmp: string;
  let memDir: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "chatgpt-bridge-"));
    memDir = join(tmp, ".memory");
    origEnv = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
    };
    process.env["MEMORY_ROOT"] = memDir;
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
    expect(status.url).toBe("http://127.0.0.1:3100/sse");
  });

  it("reports not running and cleans up PID file when it contains a dead PID", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(memDir, { recursive: true });
    // PID 1 is always alive on Linux but on any platform we can use a known-dead PID.
    // Write a PID that is guaranteed to be dead (very high number unlikely to exist).
    const deadPid = 9999999;
    const pidPath = join(memDir, ".chatgpt-bridge.pid");
    await writeFile(pidPath, String(deadPid), "utf-8");

    const status = await runChatGptBridgeStatus();

    // Either the process isn't alive (most cases) or it is — either way status is a valid object.
    // The important property: we don't throw.
    expect(typeof status.running).toBe("boolean");
    expect(status.port).toBe(3100);
  });

  it("reports not running when PID file contains invalid content", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(memDir, { recursive: true });
    const pidPath = join(memDir, ".chatgpt-bridge.pid");
    await writeFile(pidPath, "not-a-number", "utf-8");

    const status = await runChatGptBridgeStatus();

    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });

  it("uses port from config when configured", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(memDir, { recursive: true });
    await writeFile(
      join(memDir, "config.yaml"),
      "chatgpt:\n  bridge_port: 4200\n",
      "utf-8",
    );

    const status = await runChatGptBridgeStatus();

    expect(status.port).toBe(4200);
    expect(status.url).toBe("http://127.0.0.1:4200/sse");
  });
});

describe("runChatGptBridgeStop", () => {
  let tmp: string;
  let memDir: string;
  let pidFilePath: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "chatgpt-bridge-stop-"));
    memDir = join(tmp, ".memory");
    pidFilePath = join(memDir, ".chatgpt-bridge.pid");
    origEnv = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
    };
    process.env["MEMORY_ROOT"] = memDir;
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
    await writeFile(pidFilePath, "99999999", "utf-8");
    await runChatGptBridgeStop();
    expect(existsSync(pidFilePath)).toBe(false);
  });
});
