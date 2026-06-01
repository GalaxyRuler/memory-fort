import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { loadMemoryConfig, type MemoryConfig } from "../../../storage/config.js";
import { fail, pass, warn, type CheckDescriptor, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

type ExecFile = (
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number; windowsHide: boolean },
) => Promise<unknown>;

const execFileAsync = promisify(nodeExecFile);

export interface GitVerifyOptions extends VerifyCheckContext {
  remoteName?: string;
  execFile?: ExecFile;
  configLoader?: (memoryRoot?: string) => Promise<Pick<MemoryConfig, "sync">>;
}

export const gitRemoteCheck: CheckDescriptor = {
  id: "git.remote",
  label: "git remote reachable",
  roles: ["operator"],
  run: checkGitRemote,
};

export async function checkGitRemote(
  opts: GitVerifyOptions,
): Promise<VerifyCheckResult> {
  const remoteName = await resolveRemoteName(opts);
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
      "set `sync.remote_name` or run `memory sync-bootstrap --remote-name <name>`",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function resolveRemoteName(opts: GitVerifyOptions): Promise<string> {
  const explicit = opts.remoteName?.trim();
  if (explicit) return explicit;
  const config = await (opts.configLoader ?? loadMemoryConfig)(opts.vaultRoot);
  const configured = config.sync?.remote_name?.trim();
  return configured || "vps";
}
