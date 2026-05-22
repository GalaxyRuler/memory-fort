import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runInstallTailscaleRoute,
} from "../../../src/cli/commands/install-tailscale-route.js";
import type { SshCommand, SshRunner } from "../../../src/sync/ssh-runner.js";
import type { CommandRunner } from "../../../src/sync/git-remote.js";

interface RecordedSshCall {
  host: string;
  command: SshCommand;
}

function serveJson(include: { root?: boolean; highPort?: boolean; memory?: boolean }): string {
  const rootHandlers: Record<string, unknown> = {};
  if (include.root) rootHandlers["/"] = { Proxy: "http://127.0.0.1:18789" };
  if (include.memory) rootHandlers["/memory"] = { Proxy: "http://127.0.0.1:4410" };
  const web: Record<string, unknown> = {};
  if (Object.keys(rootHandlers).length > 0) {
    web["srv1317946.tail6916d8.ts.net:443"] = { Handlers: rootHandlers };
  }
  if (include.highPort) {
    web["srv1317946.tail6916d8.ts.net:8443"] = {
      Handlers: { "/": { Proxy: "http://127.0.0.1:5678" } },
    };
  }
  return JSON.stringify({ Web: web });
}

function makeSshRunner(jsons: string[]): SshRunner & { calls: RecordedSshCall[] } {
  const calls: RecordedSshCall[] = [];
  let jsonIndex = 0;
  return {
    calls,
    async run(host: string, command: SshCommand) {
      calls.push({ host, command });
      if (command.command === "tailscale serve status --json") {
        return { stdout: jsons[Math.min(jsonIndex++, jsons.length - 1)] ?? "{}", stderr: "", exitCode: 0 };
      }
      if (command.command === "tailscale serve status") {
        return { stdout: "serve status\n", stderr: "", exitCode: 0 };
      }
      if (command.command.includes("curl -sS")) {
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

function makeCommandRunner(): CommandRunner & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    async run(cmd: string, args: string[]) {
      calls.push({ cmd, args });
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
  };
}

function commandStrings(runner: { calls: RecordedSshCall[] }): string[] {
  return runner.calls.map((call) => call.command.command);
}

describe("runInstallTailscaleRoute", () => {
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

  it("Dry-run prints the command and does not execute the serve command", async () => {
    const sshRunner = makeSshRunner([serveJson({ root: true, highPort: true })]);
    const commandRunner = makeCommandRunner();

    await runInstallTailscaleRoute({ dryRun: true, sshRunner, commandRunner });

    expect(stdout).toContain("tailscale serve --bg --https=443 --set-path=/memory http://127.0.0.1:4410");
    expect(commandStrings(sshRunner).some((cmd) => cmd.startsWith("tailscale serve --bg"))).toBe(false);
  });

  it("Refuses if existing root route is missing", async () => {
    const sshRunner = makeSshRunner([serveJson({ highPort: true })]);

    await expect(runInstallTailscaleRoute({ sshRunner, commandRunner: makeCommandRunner() })).rejects.toThrow(/expected root route/);
    expect(commandStrings(sshRunner).some((cmd) => cmd.startsWith("tailscale serve --bg"))).toBe(false);
  });

  it("Refuses if existing :8443 route is missing", async () => {
    const sshRunner = makeSshRunner([serveJson({ root: true })]);

    await expect(runInstallTailscaleRoute({ sshRunner, commandRunner: makeCommandRunner() })).rejects.toThrow(/expected :8443 route/);
    expect(commandStrings(sshRunner).some((cmd) => cmd.startsWith("tailscale serve --bg"))).toBe(false);
  });

  it("Reports alreadyConfigured: true and skips command when /memory already present", async () => {
    const sshRunner = makeSshRunner([serveJson({ root: true, highPort: true, memory: true })]);
    const commandRunner = makeCommandRunner();

    const result = await runInstallTailscaleRoute({ sshRunner, commandRunner });

    expect(result.alreadyConfigured).toBe(true);
    expect(commandStrings(sshRunner).some((cmd) => cmd.startsWith("tailscale serve --bg"))).toBe(false);
    expect(commandStrings(sshRunner).some((cmd) => cmd.includes("/memory/healthz"))).toBe(true);
    expect(commandRunner.calls.some((call) => call.args.some((arg) => arg.includes("/memory/healthz")))).toBe(true);
  });

  it("Adds /memory route and verifies post-state", async () => {
    const sshRunner = makeSshRunner([
      serveJson({ root: true, highPort: true }),
      serveJson({ root: true, highPort: true, memory: true }),
    ]);

    const result = await runInstallTailscaleRoute({ sshRunner, commandRunner: makeCommandRunner() });

    expect(commandStrings(sshRunner)).toContain("tailscale serve --bg --https=443 --set-path=/memory http://127.0.0.1:4410");
    expect(result.alreadyConfigured).toBe(false);
    expect(result.postRoutes).toEqual(
      expect.arrayContaining([
        { host: "srv1317946.tail6916d8.ts.net:443", path: "/", target: "http://127.0.0.1:18789" },
        { host: "srv1317946.tail6916d8.ts.net:443", path: "/memory", target: "http://127.0.0.1:4410" },
        { host: "srv1317946.tail6916d8.ts.net:8443", path: "/", target: "http://127.0.0.1:5678" },
      ]),
    );
  });

  it("Aborts if post-check shows an existing route disappeared", async () => {
    const sshRunner = makeSshRunner([
      serveJson({ root: true, highPort: true }),
      serveJson({ highPort: true, memory: true }),
    ]);

    await expect(runInstallTailscaleRoute({ sshRunner, commandRunner: makeCommandRunner() })).rejects.toThrow(/manual.*inspect/i);
    expect(commandStrings(sshRunner).some((cmd) => cmd.includes("/memory/healthz"))).toBe(false);
  });
});
