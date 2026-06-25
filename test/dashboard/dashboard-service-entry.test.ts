import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

class FakeParentPort extends EventEmitter {
  readonly posted: unknown[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
}

const serviceProcess = process as NodeJS.Process & { parentPort?: FakeParentPort };
const originalSigtermListeners = process.listeners("SIGTERM");

describe("dashboard service utility-process entry", () => {
  afterEach(() => {
    delete serviceProcess.parentPort;
    for (const listener of process.listeners("SIGTERM")) {
      if (!originalSigtermListeners.includes(listener)) {
        process.off("SIGTERM", listener);
      }
    }
    vi.resetModules();
  });

  it("starts the service entry when process.parentPort is present", async () => {
    vi.resetModules();
    const parentPort = new FakeParentPort();
    serviceProcess.parentPort = parentPort;

    await import("../../src/dashboard/dashboard-service.js?entry-with-parent");

    expect(parentPort.listenerCount("message")).toBe(1);
  });

  it("does not start the service entry when process.parentPort is absent", async () => {
    vi.resetModules();
    delete serviceProcess.parentPort;

    await import("../../src/dashboard/dashboard-service.js?entry-without-parent");

    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  it("logs startup failures under the init vault root", async () => {
    const { startDashboardService } = await import("../../src/dashboard/dashboard-service.js");
    const vaultRoot = await mkdtemp(join(tmpdir(), "dashboard-service-vault-"));
    const parentPort = new FakeParentPort();

    const ready = startDashboardService({
      parentPort,
      runDashboardImpl: async () => {
        throw new Error("boom from startup");
      },
      exit: () => undefined,
    });

    parentPort.emit("message", {
      vaultRoot,
      dashboardDistRoot: "C:/app/dist/dashboard-ui",
    });

    await expect(ready).rejects.toThrow("boom from startup");
    const log = await readFile(join(vaultRoot, "logs", "dashboard-service.log"), "utf8");
    expect(log).toContain("boom from startup");
    expect(log).toContain("Error: boom from startup");
  });
});
