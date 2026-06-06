import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "./git-remote.js";

export async function isGitRepo(repoPath: string, runner: CommandRunner): Promise<boolean> {
  const gitPath = join(repoPath, ".git");
  if (existsSync(gitPath) && statSync(gitPath).isDirectory()) return true;

  try {
    const result = await runner.run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoPath });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}
