import { spawn } from "node:child_process";

export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; stdin?: string },
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}

export function makeRealCommandRunner(): CommandRunner {
  return {
    run(cmd: string, args: string[], opts?: { cwd?: string; stdin?: string }) {
      return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
          cwd: opts?.cwd,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.on("error", (err) => {
          reject(new Error(`${cmd} failed to start: ${err.message}`));
        });
        child.on("close", (code) => {
          resolve({ stdout, stderr, exitCode: code ?? -1 });
        });
        if (opts?.stdin !== undefined) {
          child.stdin?.end(opts.stdin);
        } else {
          child.stdin?.end();
        }
      });
    },
  };
}

export async function getRemoteUrl(
  repoPath: string,
  name: string,
  runner: CommandRunner,
): Promise<string | null> {
  const result = await runner.run("git", ["remote", "get-url", name], { cwd: repoPath });
  if (result.exitCode !== 0) return null;
  const url = result.stdout.trim();
  return url.length > 0 ? url : null;
}

export async function addRemote(
  repoPath: string,
  name: string,
  url: string,
  runner: CommandRunner,
): Promise<{ created: boolean; previousUrl: string | null }> {
  const previousUrl = await getRemoteUrl(repoPath, name, runner);
  if (previousUrl === null) {
    const result = await runner.run("git", ["remote", "add", name, url], { cwd: repoPath });
    if (result.exitCode !== 0) {
      throw new Error(`git remote add ${name} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return { created: true, previousUrl: null };
  }
  if (previousUrl !== url) {
    const result = await runner.run("git", ["remote", "set-url", name, url], { cwd: repoPath });
    if (result.exitCode !== 0) {
      throw new Error(`git remote set-url ${name} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }
  return { created: false, previousUrl };
}

export async function pushToRemote(
  repoPath: string,
  name: string,
  branch: string,
  runner: CommandRunner,
): Promise<{ pushed: boolean; output: string }> {
  const result = await runner.run("git", ["push", name, branch], { cwd: repoPath });
  const output = `${result.stderr}${result.stdout}`;
  if (result.exitCode !== 0) {
    throw new Error(`git push ${name} ${branch} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return { pushed: true, output };
}

export async function remoteHasCommits(
  repoPath: string,
  name: string,
  branch: string,
  runner: CommandRunner,
): Promise<boolean> {
  const result = await runner.run("git", ["ls-remote", name, branch], { cwd: repoPath });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-remote ${name} ${branch} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim().length > 0;
}
