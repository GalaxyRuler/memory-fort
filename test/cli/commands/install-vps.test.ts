import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstallVps, type LocalCommandRunner } from "../../../src/cli/commands/install-vps.js";
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

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function activeRunner(): SshRunner & { calls: RecordedCall[] } {
  return makeRunner((call) => ({
    stdout: call.command.command.includes("test -d")
      ? "EXISTS\n"
      : call.command.command === "which node"
        ? "/usr/local/node22/bin/node\n"
        : call.command.command.includes("curl -sS")
          ? "ok\n"
          : "active\n",
  }));
}

function expectedNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
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

  it("Installer uploads dashboard unit with substituted install root", async () => {
    const runner = makeRunner((call) => ({
      stdout: call.command.command.includes("test -d")
        ? "EXISTS\n"
        : call.command.command === "which node"
          ? "/usr/local/node22/bin/node\n"
          : call.command.command.includes("curl -sS")
            ? "ok\n"
            : "active\n",
    }));

    await runInstallVps({ installRoot: "/tmp/mem", runner });

    const upload = commands(runner).find((command) =>
      command.startsWith("cat > /etc/systemd/system/memory-dashboard.service"),
    );
    expect(upload).toBeDefined();
    expect(upload).toContain("WorkingDirectory=/tmp/mem");
    expect(upload).not.toContain("${INSTALL_ROOT}");
  });

  it("Installer uploads dashboard unit with server role and vault root environment", async () => {
    const runner = activeRunner();

    await runInstallVps({ runner });

    const upload = commands(runner).find((command) =>
      command.startsWith("cat > /etc/systemd/system/memory-dashboard.service"),
    );
    expect(upload).toBeDefined();
    expect(upload).toContain("Environment=MEMORY_ROLE=server");
    expect(upload).toContain("Environment=MEMORY_ROOT=/root/memory-system/vault");
    expect(commands(runner).some((command) => command.includes("role.conf"))).toBe(false);
  });

  it("Installer uploads hardened dashboard and backup systemd units", async () => {
    const runner = activeRunner();

    await runInstallVps({ runner });

    const dashboardUpload = commands(runner).find((command) =>
      command.startsWith("cat > /etc/systemd/system/memory-dashboard.service"),
    );
    const backupUpload = commands(runner).find((command) =>
      command.startsWith("cat > /etc/systemd/system/memory-backup.service"),
    );
    expect(dashboardUpload).toBeDefined();
    expect(backupUpload).toBeDefined();
    for (const directive of [
      "NoNewPrivileges=yes",
      "PrivateTmp=yes",
      "ProtectSystem=strict",
      "ProtectHome=read-only",
      "ProtectKernelTunables=yes",
      "ProtectControlGroups=yes",
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
      "RestrictNamespaces=yes",
      "LockPersonality=yes",
      "SystemCallFilter=@system-service",
    ]) {
      expect(dashboardUpload).toContain(directive);
      expect(backupUpload).toContain(directive);
    }
    expect(dashboardUpload).toContain("ReadWritePaths=/root/memory-system");
    expect(backupUpload).toContain("ReadWritePaths=/root/memory-system/backups /root/memory-system/logs");
  });

  it("Installer reruns do not duplicate dashboard environment lines", async () => {
    const runner = activeRunner();

    await runInstallVps({ runner });
    await runInstallVps({ runner });

    const uploads = commands(runner).filter((command) =>
      command.startsWith("cat > /etc/systemd/system/memory-dashboard.service"),
    );
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(countOccurrences(upload, "Environment=MEMORY_ROLE=server")).toBe(1);
      expect(countOccurrences(upload, "Environment=MEMORY_ROOT=/root/memory-system/vault")).toBe(1);
    }
  });

  it("Installer uploads backup script with executable bit", async () => {
    const runner = makeRunner((call) => ({
      stdout: call.command.command.includes("test -d")
        ? "EXISTS\n"
        : call.command.command === "which node"
          ? "/usr/local/node22/bin/node\n"
          : call.command.command.includes("curl -sS")
            ? "ok\n"
            : "active\n",
    }));

    await runInstallVps({ runner });

    expect(commands(runner).some((command) => command.startsWith("cat > /root/memory-system/services/memory-backup.sh"))).toBe(true);
    expect(commands(runner)).toContain("chmod 755 /root/memory-system/services/memory-backup.sh");
  });

  it("Installer uploads fail-closed backup script with archive verification", async () => {
    const runner = activeRunner();

    await runInstallVps({ runner });

    const upload = commands(runner).find((command) =>
      command.startsWith("cat > /root/memory-system/services/memory-backup.sh"),
    );
    expect(upload).toBeDefined();
    expect(upload).toContain("set -euo pipefail");
    expect(upload).not.toContain("|| true");
    expect(upload).toContain("--verify");
    expect(upload).toContain("tar -tzf");
    expect(upload).toContain("backup failed");
    expect(upload).toContain("mv \"$TMP_ARCHIVE\" \"$ARCHIVE\"");
  });

  it("Installer restricts environment file permissions", async () => {
    const runner = activeRunner();

    await runInstallVps({ runner });

    expect(commands(runner)).toContain("find /root/memory-system/env -type f -exec chmod 600 {} +");
  });

  it("Installer runs daemon-reload and enables services", async () => {
    const runner = makeRunner((call) => ({
      stdout: call.command.command.includes("test -d")
        ? "EXISTS\n"
        : call.command.command === "which node"
          ? "/usr/local/node22/bin/node\n"
          : call.command.command.includes("curl -sS")
            ? "ok\n"
            : "active\n",
    }));

    await runInstallVps({ runner });

    expect(commands(runner)).toContain("systemctl daemon-reload");
    expect(commands(runner)).toContain("systemctl enable --now memory-dashboard.service");
    expect(commands(runner)).toContain("systemctl enable --now memory-backup.timer");
  });

  it("Result includes systemd verification fields", async () => {
    const runner = makeRunner((call) => {
      if (call.command.command.includes("test -d")) return { stdout: "EXISTS\n" };
      if (call.command.command === "which node") return { stdout: "/usr/local/node22/bin/node\n" };
      if (call.command.command === "systemctl is-active memory-dashboard.service") return { stdout: "active\n" };
      if (call.command.command === "systemctl is-active memory-backup.timer") return { stdout: "active\n" };
      if (call.command.command.includes("systemctl list-timers")) {
        return { stdout: "Sat 2026-05-23 04:00:00 UTC 2h left n/a n/a memory-backup.timer memory-backup.service\n" };
      }
      if (call.command.command.includes("curl -sS")) return { stdout: "ok\n" };
      return { stdout: "same\n" };
    });

    const result = await runInstallVps({ runner });

    expect(result.systemd.dashboardServiceActive).toBe(true);
    expect(result.systemd.backupTimerActive).toBe(true);
    expect(result.systemd.healthzOk).toBe(true);
    expect(result.systemd.nodePath).toBe("/usr/local/node22/bin/node");
  });

  it("Installer fails cleanly if Node not found on VPS", async () => {
    const runner = makeRunner((call) => {
      if (call.command.command.includes("test -d")) return { stdout: "EXISTS\n" };
      if (call.command.command === "which node") return { stderr: "not found", exitCode: 1 };
      return { stdout: "same\n" };
    });

    await expect(runInstallVps({ runner })).rejects.toThrow(/Node.*srv1317946/);
  });

  it("Installer syncs dist/dashboard-ui to the VPS with rsync --delete", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "install-vps-ui-"));
    const dashboardDistRoot = join(tmpRoot, "dist", "dashboard-ui");
    await mkdir(join(dashboardDistRoot, "assets"), { recursive: true });
    await writeFile(join(dashboardDistRoot, "index.html"), "<div id=\"root\"></div>");

    const localCommands: Array<{ command: string; args: string[] }> = [];
    const localRunner: LocalCommandRunner = {
      async run(command, args) {
        localCommands.push({ command, args });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    try {
      await runInstallVps({
        installRoot: "/tmp/mem",
        runner: activeRunner(),
        dashboardDistRoot,
        localRunner,
      });

      expect(localCommands).toEqual([
        {
          command: expectedNpmCommand(),
          args: ["run", "build:ui"],
        },
        {
          command: "rsync",
          args: [
            "-az",
            "--delete",
            `${dashboardDistRoot.replace(/\\/g, "/")}/`,
            "srv1317946:/tmp/mem/dist/dashboard-ui/",
          ],
        },
      ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("Installer falls back to scp mirroring when rsync is unavailable", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "install-vps-ui-"));
    const dashboardDistRoot = join(tmpRoot, "dist", "dashboard-ui");
    await mkdir(join(dashboardDistRoot, "assets"), { recursive: true });
    await writeFile(join(dashboardDistRoot, "index.html"), "<div id=\"root\"></div>");

    const runner = activeRunner();
    const localCommands: Array<{ command: string; args: string[] }> = [];
    const localRunner: LocalCommandRunner = {
      async run(command, args) {
        localCommands.push({ command, args });
        if (command === "rsync") {
          throw new Error("rsync failed to start: spawn rsync ENOENT");
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    try {
      await runInstallVps({
        installRoot: "/tmp/mem",
        runner,
        dashboardDistRoot,
        localRunner,
      });

      expect(commands(runner)).toContain("rm -rf /tmp/mem/dist/dashboard-ui && mkdir -p /tmp/mem/dist/dashboard-ui");
      expect(localCommands).toEqual([
        {
          command: expectedNpmCommand(),
          args: ["run", "build:ui"],
        },
        {
          command: "rsync",
          args: [
            "-az",
            "--delete",
            `${dashboardDistRoot.replace(/\\/g, "/")}/`,
            "srv1317946:/tmp/mem/dist/dashboard-ui/",
          ],
        },
        {
          command: "scp",
          args: [
            "-r",
            `${dashboardDistRoot.replace(/\\/g, "/")}/.`,
            "srv1317946:/tmp/mem/dist/dashboard-ui/",
          ],
        },
      ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
