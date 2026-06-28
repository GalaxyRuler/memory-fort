import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createDashboardServiceSupervisor } from "../../src/dashboard/dashboard-service-supervisor.js";

class FakeChild extends EventEmitter {
  readonly sent: unknown[] = [];
  readonly pid = 1234;
  killed = false;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  kill(): void {
    this.killed = true;
  }
}

describe("dashboard service supervisor", () => {
  it("forks the service, waits for the ready URL, then restarts with capped exponential backoff after crashes", async () => {
    const children: FakeChild[] = [];
    const delays: number[] = [];
    const reloads: string[] = [];
    const timers: Array<() => void> = [];

    const supervisor = createDashboardServiceSupervisor({
      servicePath: "C:/app/dist/dashboard/dashboard-service.mjs",
      vaultRoot: "C:/vault",
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
      fork: (servicePath) => {
        expect(servicePath).toBe("C:/app/dist/dashboard/dashboard-service.mjs");
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      setTimeout: (handler, ms) => {
        delays.push(ms);
        timers.push(handler);
        return handler;
      },
      clearTimeout: () => undefined,
      onReady: (ready) => {
        reloads.push(ready.url);
      },
    });

    const firstReady = supervisor.start();
    expect(children).toHaveLength(1);
    expect(children[0].sent).toEqual([{
      vaultRoot: "C:/vault",
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
    }]);

    children[0].emit("message", { url: "http://127.0.0.1:4410/memory/", port: 4410 });
    await expect(firstReady).resolves.toEqual({ url: "http://127.0.0.1:4410/memory/", port: 4410 });
    expect(reloads).toEqual(["http://127.0.0.1:4410/memory/"]);

    children[0].emit("exit", 1);
    expect(delays).toEqual([500]);
    timers.shift()?.();
    expect(children).toHaveLength(2);

    children[1].emit("message", { url: "http://127.0.0.1:4411/memory/", port: 4411 });
    await Promise.resolve();
    expect(reloads).toEqual([
      "http://127.0.0.1:4410/memory/",
      "http://127.0.0.1:4411/memory/",
    ]);

    children[1].emit("exit", 1);
    expect(delays).toEqual([500, 500]);
  });

  it("stops restarting after consecutive pre-ready crashes exhaust the guard", async () => {
    const children: FakeChild[] = [];
    const timers: Array<() => void> = [];

    const supervisor = createDashboardServiceSupervisor({
      servicePath: "C:/app/dist/dashboard/dashboard-service.mjs",
      vaultRoot: "C:/vault",
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      setTimeout: (handler) => {
        timers.push(handler);
        return handler;
      },
      clearTimeout: () => undefined,
      maxRestarts: 2,
    });

    const ready = supervisor.start();
    void ready.catch(() => undefined);
    children[0].emit("exit", 1);
    timers.shift()?.();

    children[1].emit("exit", 1);
    timers.shift()?.();

    children[2].emit("exit", 1);
    await Promise.resolve();
    expect(timers).toHaveLength(0);
    expect(children).toHaveLength(3);
  });

  it("resolves the initial start after a pre-ready crash is recovered", async () => {
    const children: FakeChild[] = [];
    const timers: Array<() => void> = [];

    const supervisor = createDashboardServiceSupervisor({
      servicePath: "C:/app/dist/dashboard/dashboard-service.mjs",
      vaultRoot: "C:/vault",
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      setTimeout: (handler) => {
        timers.push(handler);
        return handler;
      },
      clearTimeout: () => undefined,
    });

    const ready = supervisor.start();
    children[0].emit("exit", 1);
    timers.shift()?.();
    children[1].emit("message", { url: "http://127.0.0.1:4411/memory/", port: 4411 });

    await expect(ready).resolves.toEqual({ url: "http://127.0.0.1:4411/memory/", port: 4411 });
  });

  it("rejects start when the service exhausts retries before becoming ready", async () => {
    const children: FakeChild[] = [];
    const timers: Array<() => void> = [];

    const supervisor = createDashboardServiceSupervisor({
      servicePath: "C:/app/dist/dashboard/dashboard-service.mjs",
      vaultRoot: "C:/vault",
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      setTimeout: (handler) => {
        timers.push(handler);
        return handler;
      },
      clearTimeout: () => undefined,
      maxRestarts: 2,
    });

    const ready = supervisor.start();
    let result: unknown = "pending";
    void ready.catch((error: unknown) => {
      result = error;
    });
    children[0].emit("exit", 1);
    timers.shift()?.();
    children[1].emit("exit", 1);
    timers.shift()?.();
    children[2].emit("exit", 1);
    await Promise.resolve();
    expect(children).toHaveLength(3);
    expect(timers).toHaveLength(0);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("dashboard service failed to start after 3 attempts");
  });

  it("keeps restarting after more than maxRestarts crashes when each service becomes ready first", async () => {
    const children: FakeChild[] = [];
    const timers: Array<() => void> = [];

    const supervisor = createDashboardServiceSupervisor({
      servicePath: "C:/app/dist/dashboard/dashboard-service.mjs",
      vaultRoot: "C:/vault",
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      setTimeout: (handler) => {
        timers.push(handler);
        return handler;
      },
      clearTimeout: () => undefined,
      maxRestarts: 2,
    });

    void supervisor.start();
    for (let i = 0; i < 4; i += 1) {
      children[i].emit("message", { url: `http://127.0.0.1:${4410 + i}/memory/`, port: 4410 + i });
      await Promise.resolve();
      children[i].emit("exit", 1);
      expect(timers).toHaveLength(1);
      timers.shift()?.();
    }

    expect(children).toHaveLength(5);
  });

  it("passes runtime environment details to the forked service", () => {
    const runtimeEvents: unknown[] = [];
    const children: FakeChild[] = [];
    const supervisor = createDashboardServiceSupervisor({
      servicePath: "C:/app/dist/dashboard/dashboard-service.mjs",
      vaultRoot: "C:/vault",
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      runtimeEnv: {
        electron: "42.5.0",
        node: "24.18.0",
        modules: "140",
        platform: "win32",
        arch: "x64",
        appPath: "C:/app",
        servicePath: "C:/app/dist/dashboard/dashboard-service.mjs",
        parentPid: 99,
      },
      onRuntimeEnv: (env) => runtimeEvents.push(env),
    });

    void supervisor.start();

    expect(runtimeEvents).toEqual([{
      electron: "42.5.0",
      node: "24.18.0",
      modules: "140",
      platform: "win32",
      arch: "x64",
      appPath: "C:/app",
      servicePath: "C:/app/dist/dashboard/dashboard-service.mjs",
      parentPid: 99,
      utilityChildPid: 1234,
    }]);
    expect(children[0].sent).toEqual([{
      vaultRoot: "C:/vault",
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
      runtimeEnv: runtimeEvents[0],
    }]);
  });

  it("forwards non-ready child messages while waiting for readiness", async () => {
    const messages: unknown[] = [];
    const children: FakeChild[] = [];
    const supervisor = createDashboardServiceSupervisor({
      servicePath: "C:/app/dist/index/native/capability-probe.mjs",
      vaultRoot: "C:/vault",
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      onMessage: (message) => messages.push(message),
    });

    const ready = supervisor.start();
    children[0].emit("message", { type: "cap-probe-log", line: "step1 runtime ok" });
    children[0].emit("message", { url: "cap-probe://ok", port: 0 });

    await expect(ready).resolves.toEqual({ url: "cap-probe://ok", port: 0 });
    expect(messages).toEqual([{ type: "cap-probe-log", line: "step1 runtime ok" }]);
  });
});
