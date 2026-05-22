import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runSyncBootstrap } from "../../../src/cli/commands/sync-bootstrap.js";
import type { CommandRunner } from "../../../src/sync/git-remote.js";
import type { SshCommand, SshRunner } from "../../../src/sync/ssh-runner.js";

const execFileAsync = promisify(execFile);

interface RecordedCommand {
  cmd: string;
  args: string[];
  opts?: { cwd?: string; stdin?: string };
}

interface RecordedSsh {
  host: string;
  command: SshCommand;
}

function makeCommandRunner(
  handler: (call: RecordedCommand, index: number) => {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  } = () => ({ stdout: "" }),
): CommandRunner & { calls: RecordedCommand[] } {
  const calls: RecordedCommand[] = [];
  return {
    calls,
    async run(cmd: string, args: string[], opts?: { cwd?: string; stdin?: string }) {
      const call = { cmd, args, opts };
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

function makeSshRunner(): SshRunner & { calls: RecordedSsh[] } {
  const calls: RecordedSsh[] = [];
  return {
    calls,
    async run(host: string, command: SshCommand) {
      calls.push({ host, command });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

function gitArgs(runner: { calls: RecordedCommand[] }): string[] {
  return runner.calls.map((call) => [call.cmd, ...call.args].join(" "));
}

describe("runSyncBootstrap", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "syncboot-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function initGitRepo(dir = tmp): Promise<void> {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  }

  it("Throws if memory root is not a git repo", async () => {
    await expect(runSyncBootstrap({ memoryRoot: tmp })).rejects.toThrow(/not a git repo.*memory init/);
  });

  it("Constructs the correct remote URL", async () => {
    await initGitRepo();
    const commandRunner = makeCommandRunner((call) =>
      call.args.includes("get-url") ? { exitCode: 2 } : { stdout: "" },
    );
    const sshRunner = makeSshRunner();

    const result = await runSyncBootstrap({
      memoryRoot: tmp,
      sshHost: "foo",
      vpsInstallRoot: "/srv/mem",
      skipInitialPush: true,
      commandRunner,
      sshRunner,
    });

    expect(gitArgs(commandRunner)).toContain("git remote add vps root@foo:/srv/mem/memory.git");
    expect(result.remoteUrl).toBe("root@foo:/srv/mem/memory.git");
  });

  it("Idempotency: re-running with existing remote of same URL is a no-op for git remote", async () => {
    await initGitRepo();
    const url = "root@srv1317946:/root/memory-system/memory.git";
    const firstRunner = makeCommandRunner((call) =>
      call.args.includes("get-url") ? { exitCode: 2 } : { stdout: "" },
    );
    const secondRunner = makeCommandRunner((call) =>
      call.args.includes("get-url") ? { stdout: `${url}\n` } : { stdout: "" },
    );
    const sshRunner = makeSshRunner();

    await runSyncBootstrap({
      memoryRoot: tmp,
      skipInitialPush: true,
      commandRunner: firstRunner,
      sshRunner,
    });
    const second = await runSyncBootstrap({
      memoryRoot: tmp,
      skipInitialPush: true,
      commandRunner: secondRunner,
      sshRunner,
    });

    expect(second.remoteCreated).toBe(false);
    expect(second.previousRemoteUrl).toBe(url);
    expect(gitArgs(secondRunner).filter((cmd) => cmd.includes(" remote add "))).toEqual([]);
  });

  it("Post-receive hook content matches the template", async () => {
    await initGitRepo();
    const commandRunner = makeCommandRunner((call) =>
      call.args.includes("get-url") ? { exitCode: 2 } : { stdout: "" },
    );
    const sshRunner = makeSshRunner();
    const template = (await readFile(join(process.cwd(), "templates", "vps", "post-receive.sh"), "utf-8")).replace(
      /\r\n/g,
      "\n",
    );

    await runSyncBootstrap({
      memoryRoot: tmp,
      skipInitialPush: true,
      commandRunner,
      sshRunner,
    });

    expect(sshRunner.calls.some((call) => call.command.command.includes(template))).toBe(true);
    expect(
      sshRunner.calls.some((call) =>
        call.command.command === "chmod +x /root/memory-system/memory.git/hooks/post-receive"
      ),
    ).toBe(true);
  });

  it("Initial push is performed when remote is empty", async () => {
    await initGitRepo();
    const commandRunner = makeCommandRunner((call) => {
      if (call.args.includes("get-url")) return { exitCode: 2 };
      if (call.args.includes("ls-remote")) return { stdout: "" };
      return { stdout: "" };
    });
    const sshRunner = makeSshRunner();

    const result = await runSyncBootstrap({
      memoryRoot: tmp,
      commandRunner,
      sshRunner,
    });

    expect(gitArgs(commandRunner)).toContain("git push vps main");
    expect(result.initialPushPerformed).toBe(true);
  });

  it("Initial push is skipped when remote has commits", async () => {
    await initGitRepo();
    const commandRunner = makeCommandRunner((call) => {
      if (call.args.includes("get-url")) return { exitCode: 2 };
      if (call.args.includes("ls-remote")) return { stdout: "abc123\trefs/heads/main\n" };
      return { stdout: "" };
    });
    const sshRunner = makeSshRunner();

    const result = await runSyncBootstrap({
      memoryRoot: tmp,
      commandRunner,
      sshRunner,
    });

    expect(gitArgs(commandRunner).some((cmd) => cmd === "git push vps main")).toBe(false);
    expect(result.initialPushPerformed).toBe(false);
  });
});
