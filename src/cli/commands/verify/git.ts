import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { fail, pass, warn, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

type ExecFile = (
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number; windowsHide: boolean },
) => Promise<unknown>;

const execFileAsync = promisify(nodeExecFile);

export interface GitVerifyOptions extends VerifyCheckContext {
  remoteName?: string;
  execFile?: ExecFile;
}

export async function checkGitRemote(
  opts: GitVerifyOptions,
): Promise<VerifyCheckResult> {
  const remoteName = opts.remoteName ?? "vps";
  if (opts.offline) {
    return warn(
      "git.remote",
      `git remote ${remoteName} skipped (--offline)`,
    );
  }

  try {
    await (opts.execFile ?? execFileAsync)("git", ["ls-remote", remoteName], {
      cwd: opts.vaultRoot,
      timeout: 5000,
      windowsHide: true,
    });
    return pass("git.remote", `git remote ${remoteName} reachable`);
  } catch (error) {
    return fail(
      "git.remote",
      `git remote ${remoteName} reachable`,
      "run `memory sync-bootstrap`",
      error instanceof Error ? error.message : String(error),
    );
  }
}
