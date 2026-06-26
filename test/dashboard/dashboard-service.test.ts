import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startDashboardService } from "../../src/dashboard/dashboard-service.js";
import type { DashboardRun } from "../../src/cli/commands/dashboard.js";

class FakeParentPort extends EventEmitter {
  readonly posted: unknown[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
}

describe("dashboard service entry", () => {
  it("starts the dashboard from its initial message and posts the actual bound URL and port", async () => {
    const parentPort = new FakeParentPort();
    const calls: unknown[] = [];
    let closeCalls = 0;

    const ready = startDashboardService({
      parentPort,
      runDashboardImpl: async (opts) => {
        calls.push(opts);
        return {
          url: "http://127.0.0.1:4417/memory/",
          host: "127.0.0.1",
          port: 4417,
          close: async () => {
            closeCalls += 1;
          },
        } satisfies DashboardRun;
      },
      exit: () => undefined,
    });

    parentPort.emit("message", {
      vaultRoot: "C:/vault",
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
    });

    await ready;

    expect(calls).toEqual([{
      noOpen: true,
      vaultRoot: "C:/vault",
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
    }]);
    expect(parentPort.posted).toEqual([{ url: "http://127.0.0.1:4417/memory/", port: 4417 }]);
    expect(closeCalls).toBe(0);
  });

  it("accepts Electron parentPort message events with data payloads", async () => {
    const parentPort = new FakeParentPort();

    const ready = startDashboardService({
      parentPort,
      runDashboardImpl: async (opts) => ({
        url: `http://127.0.0.1:4418/memory/?root=${opts.vaultRoot}`,
        host: "127.0.0.1",
        port: 4418,
        close: async () => undefined,
      }),
      exit: () => undefined,
    });

    parentPort.emit("message", {
      data: {
        vaultRoot: "C:/vault",
        dashboardDistRoot: "C:/app/dist/dashboard-ui",
      },
      ports: [],
    });

    await expect(ready).resolves.toEqual({
      url: "http://127.0.0.1:4418/memory/?root=C:/vault",
      port: 4418,
    });
  });

  it("closes the running dashboard on shutdown before exiting", async () => {
    const parentPort = new FakeParentPort();
    let closeCalls = 0;
    const exitCodes: number[] = [];

    const ready = startDashboardService({
      parentPort,
      runDashboardImpl: async () => ({
        url: "http://127.0.0.1:4410/memory/",
        host: "127.0.0.1",
        port: 4410,
        close: async () => {
          closeCalls += 1;
        },
      }),
      exit: (code) => {
        exitCodes.push(code);
      },
    });

    parentPort.emit("message", {
      vaultRoot: "C:/vault",
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
    });
    await ready;

    parentPort.emit("message", { type: "shutdown" });
    await Promise.resolve();

    expect(closeCalls).toBe(1);
    expect(exitCodes).toEqual([0]);
  });

  it("logs the main and child runtime environment before serving", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "dashboard-service-runtime-"));
    const parentPort = new FakeParentPort();
    const ready = startDashboardService({
      parentPort,
      runDashboardImpl: async () => ({
        url: "http://127.0.0.1:4410/memory/",
        host: "127.0.0.1",
        port: 4410,
        close: async () => undefined,
      }),
      exit: () => undefined,
    });

    parentPort.emit("message", {
      vaultRoot,
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
      runtimeEnv: {
        electron: "42.5.0",
        node: "24.18.0",
        modules: "140",
        platform: "win32",
        arch: "x64",
        appPath: "C:/app",
        servicePath: "C:/app/dist/dashboard/dashboard-service.mjs",
        parentPid: 99,
        utilityChildPid: 1234,
      },
    });

    await ready;

    const log = await readFile(join(vaultRoot, "logs", "dashboard-service.log"), "utf8");
    expect(log).toContain("\"appPath\":\"C:/app\"");
    expect(log).toContain("\"servicePath\":\"C:/app/dist/dashboard/dashboard-service.mjs\"");
    expect(log).toContain("\"utilityChildPid\":1234");
    expect(log).toContain("\"parentPid\":99");
    expect(log).toContain("\"childPid\":");
    expect(log).toContain("\"serviceEntryPath\":");
    expect(log).toContain("\"parentPortPresent\":");
    expect(log).toContain("\"electron\":");
    expect(log).toContain("\"node\":");
    expect(log).toContain("\"modules\":");
    expect(log).toContain("\"platform\":");
    expect(log).toContain("\"arch\":");
  });
});
