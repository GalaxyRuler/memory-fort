import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  readOpenCovenReadiness,
  runInstallOpenCoven,
} from "../../../src/cli/commands/install/opencoven.js";

describe("OpenCoven readiness", () => {
  it("reports installed when the coven CLI and v1 daemon capabilities are ready", async () => {
    const home = "C:/tmp/.coven";
    const status = await readOpenCovenReadiness({
      env: { COVEN_HOME: home },
      findCommand: () => "C:/bin/coven.cmd",
      healthProbe: async (socketPath) => ({
        ok: true,
        apiVersion: "coven.daemon.v1",
        covenVersion: "0.0.32",
        capabilities: {
          sessions: true,
          events: true,
          eventCursor: "sequence",
          structuredErrors: true,
        },
        daemon: { socket: socketPath },
      }),
    });

    expect(status.state).toBe("installed");
    expect(status.commandPath).toBe("C:/bin/coven.cmd");
    expect(status.socketPath).toBe(join(home, "coven.sock"));
    expect(status.detail).toContain("coven.daemon.v1");
    expect(status.detail).toContain("sessions/events ready");
  });

  it("reports stale when the coven CLI exists but the daemon is unavailable", async () => {
    const status = await readOpenCovenReadiness({
      env: { COVEN_HOME: "C:/tmp/.coven" },
      findCommand: () => "C:/bin/coven.cmd",
      healthProbe: async () => {
        throw new Error("connect ENOENT");
      },
    });

    expect(status.state).toBe("stale");
    expect(status.detail).toContain("daemon not reachable");
    expect(status.detail).toContain("coven daemon start");
  });

  it("reports missing when the coven CLI is not on PATH and does not probe the daemon", async () => {
    let probed = false;
    const status = await readOpenCovenReadiness({
      env: { COVEN_HOME: "C:/tmp/.coven" },
      findCommand: () => null,
      healthProbe: async () => {
        probed = true;
        throw new Error("should not probe");
      },
    });

    expect(status.state).toBe("missing");
    expect(status.detail).toContain("coven CLI not found");
    expect(status.detail).toContain("@opencoven/cli");
    expect(probed).toBe(false);
  });

  it("fails closed on unsupported daemon API versions", async () => {
    const status = await readOpenCovenReadiness({
      env: { COVEN_HOME: "C:/tmp/.coven" },
      findCommand: () => "C:/bin/coven.cmd",
      healthProbe: async () => ({
        ok: true,
        apiVersion: "coven.daemon.v2",
        capabilities: { sessions: true, events: true, structuredErrors: true },
      }),
    });

    expect(status.state).toBe("stale");
    expect(status.detail).toContain("unsupported Coven API");
    expect(status.detail).toContain("coven.daemon.v2");
  });

  it("runs as a read-only install check without planned writes", async () => {
    const result = await runInstallOpenCoven({
      env: { COVEN_HOME: "C:/tmp/.coven" },
      findCommand: () => "C:/bin/coven.cmd",
      healthProbe: async () => ({
        ok: true,
        apiVersion: "coven.daemon.v1",
        capabilities: {
          sessions: true,
          events: true,
          eventCursor: "sequence",
          structuredErrors: true,
        },
      }),
    });

    expect(result.state).toBe("installed");
    expect(result.plannedWrites).toEqual([]);
    expect(result.log).toContain("read-only readiness check; no files written");
  });
});
