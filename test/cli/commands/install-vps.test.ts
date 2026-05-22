import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runInstallVps } from "../../../src/cli/commands/install-vps.js";
import type { SshCommand, SshRunner } from "../../../src/sync/ssh-runner.js";

interface RecordedCall {
  host: string;
  command: SshCommand;
}

function makeRunner(
  handler: (call: RecordedCall, index: number) => {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  } = () => ({ stdout: "", stderr: "", exitCode: 0 }),
): SshRunner & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async run(host: string, command: SshCommand) {
      const call = { host, command };
      calls.push(call);
      const result = handler(call, calls.length - 1);
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
  };
}

function commands(runner: { calls: RecordedCall[] }): string[] {
  return runner.calls.map((call) => call.command.command);
}

describe("runInstallVps", () => {
  let stdout = "";
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = "";
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("Dry-run prints commands without executing", async () => {
    const runner: SshRunner = {
      async run() {
        throw new Error("runner should not be called");
      },
    };

    const result = await runInstallVps({ dryRun: true, runner });

    expect(result.steps).toEqual([]);
    expect(result.preSnapshot).toEqual({
      tailscaleServe: "",
      listening: "",
      caddyStatus: "",
    });
    expect(result.postSnapshot).toEqual({
      tailscaleServe: "",
      listening: "",
      caddyStatus: "",
    });
    expect(result.servicesChanged).toBe(false);
    const expected = [
      "tailscale serve status",
      "ss -tlnp | head -50",
      "systemctl is-active caddy vaultwarden 2>&1 || true",
      "test -d /root/memory-system && echo EXISTS || echo MISSING",
      "mkdir -p /root/memory-system/{vault,backups,logs,services,env}",
      "[ -d /root/memory-system/memory.git ] || git init --bare /root/memory-system/memory.git",
      "chmod 700 /root/memory-system",
      "chmod 700 /root/memory-system/env",
      "cat > /root/memory-system/install-info.json <<EOF",
      "tailscale serve status",
      "ss -tlnp | head -50",
      "systemctl is-active caddy vaultwarden 2>&1 || true",
    ];
    let cursor = 0;
    for (const command of expected) {
      const needle = `[dry-run] $ ssh srv1317946 '${command}`;
      const next = stdout.indexOf(needle, cursor);
      expect(next, `missing dry-run command: ${command}`).toBeGreaterThanOrEqual(0);
      cursor = next + needle.length;
    }
  });

  it("Default host is srv1317946 when no flag or config provided", async () => {
    const runner = makeRunner((call) => ({
      stdout: call.command.command.includes("test -d") ? "MISSING\n" : "same\n",
    }));

    const result = await runInstallVps({ runner });

    expect(result.host).toBe("srv1317946");
  });

  it("Default install root is /root/memory-system", async () => {
    const runner = makeRunner((call) => ({
      stdout: call.command.command.includes("test -d") ? "MISSING\n" : "same\n",
    }));

    const result = await runInstallVps({ runner });

    expect(result.installRoot).toBe("/root/memory-system");
  });

  it("Custom host and install root flow through", async () => {
    const runner = makeRunner((call) => ({
      stdout: call.command.command.includes("test -d") ? "MISSING\n" : "same\n",
    }));

    await runInstallVps({
      sshHost: "other-host",
      installRoot: "/tmp/test-mem",
      runner,
    });

    expect(runner.calls.every((call) => call.host === "other-host")).toBe(true);
    expect(commands(runner).some((command) => command.includes("/tmp/test-mem"))).toBe(true);
    expect(commands(runner).filter((command) => command.includes("/root/memory-system"))).toEqual([]);
  });

  it("Idempotency - install root exists", async () => {
    const runner = makeRunner((call) => ({
      stdout: call.command.command.includes("test -d") ? "EXISTS\n" : "same\n",
    }));

    await runInstallVps({ runner });

    expect(commands(runner).some((command) => command.startsWith("mkdir -p"))).toBe(false);
    expect(commands(runner).some((command) => command.includes("git init --bare"))).toBe(true);
  });

  it("Pre and post snapshots captured and compared", async () => {
    const stableRunner = makeRunner((call) => ({
      stdout: call.command.command.includes("test -d") ? "EXISTS\n" : "same\n",
    }));
    const stable = await runInstallVps({ runner: stableRunner });
    expect(stable.servicesChanged).toBe(false);

    const changingRunner = makeRunner((call, index) => ({
      stdout: call.command.command.includes("test -d")
        ? "EXISTS\n"
        : index >= 5
          ? "after\n"
          : "before\n",
    }));
    const changed = await runInstallVps({ runner: changingRunner });
    expect(changed.servicesChanged).toBe(true);
  });

  it("SSH command failure surfaces clean error", async () => {
    const runner = makeRunner((call) => {
      if (call.command.command.includes("test -d")) {
        return { stdout: "MISSING\n" };
      }
      if (call.command.command.startsWith("mkdir -p")) {
        return { stderr: "Permission denied", exitCode: 1 };
      }
      return { stdout: "same\n" };
    });

    await expect(runInstallVps({ runner })).rejects.toThrow(/mkdir.*Permission denied/);
    expect(commands(runner).filter((command) => command === "tailscale serve status")).toHaveLength(1);
  });
});
