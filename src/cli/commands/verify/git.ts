import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { loadMemoryConfig, type MemoryConfig } from "../../../storage/config.js";
import { makeRealSshRunner, type SshRunner } from "../../../sync/ssh-runner.js";
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
  configLoader?: (memoryRoot?: string) => Promise<Pick<MemoryConfig, "sync" | "vps">>;
  sshRunner?: SshRunner;
}

export const gitRemoteCheck: CheckDescriptor = {
  id: "git.remote",
  label: "git remote reachable",
  roles: ["operator"],
  run: checkGitRemote,
};

export const gitDurabilityConfigCheck: CheckDescriptor = {
  id: "git.durability-config",
  label: "git durability config (fsync) applied",
  roles: ["operator"],
  run: checkGitDurabilityConfig,
};

export const gitIntegrityCheck: CheckDescriptor = {
  id: "git.integrity",
  label: "git repository has no corruption",
  roles: ["operator"],
  timeoutMs: 120_000,
  run: checkGitIntegrity,
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

export async function checkGitIntegrity(
  opts: GitVerifyOptions,
): Promise<VerifyCheckResult[]> {
  if (opts.offline) {
    return [
      warn(
        "git.integrity",
        "git repository has no corruption",
        "git fsck skipped (--offline)",
      ),
    ];
  }

  const results: VerifyCheckResult[] = [];
  const local = await checkLocalGitIntegrity(opts);
  results.push(local);
  if (local.status === "fail") return results;
  results.push(await checkRemoteGitIntegrity(opts));
  return results;
}

export async function checkGitDurabilityConfig(
  opts: GitVerifyOptions,
): Promise<VerifyCheckResult> {
  try {
    const result = await (opts.execFile ?? execFileAsync)(
      "git",
      ["config", "--get", "core.fsync"],
      {
        cwd: opts.vaultRoot,
        timeout: 5000,
        windowsHide: true,
      },
    );
    const value = (result as { stdout: string }).stdout?.trim();
    if (!value) {
      return fail(
        "git.durability-config",
        "git durability config (fsync) applied",
        "run `memory init` again, or: git -C <vault> config core.fsync committed",
        "core.fsync not set",
      );
    }
    if (value !== "committed") {
      return warn(
        "git.durability-config",
        "git durability config (fsync) applied",
        `core.fsync = ${value}; expected 'committed' for full durability`,
      );
    }
    return pass(
      "git.durability-config",
      "git durability config (fsync) applied",
      "core.fsync=committed",
    );
  } catch (error) {
    if (isUnsetGitConfigError(error)) {
      return fail(
        "git.durability-config",
        "git durability config (fsync) applied",
        "run `memory init` again, or: git -C <vault> config core.fsync committed",
        "core.fsync not set",
      );
    }
    return fail(
      "git.durability-config",
      "git durability config (fsync) applied",
      "check git installation and vault permissions",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function isUnsetGitConfigError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeGitError = error as { code?: unknown; stderr?: unknown };
  const stderr = typeof maybeGitError.stderr === "string" ? maybeGitError.stderr : "";
  return maybeGitError.code === 1 && stderr.trim().length === 0;
}

async function checkLocalGitIntegrity(
  opts: GitVerifyOptions,
): Promise<VerifyCheckResult> {
  try {
    await (opts.execFile ?? execFileAsync)(
      "git",
      // --connectivity-only: verify every ref reaches a present, valid object
      // (catches the missing/unreachable-object corruption that breaks sync)
      // WITHOUT re-hashing every object. Full --strict fsck on a large vault
      // takes minutes and was timing out here, false-reporting "corrupted".
      ["fsck", "--full", "--connectivity-only", "--no-dangling"],
      {
        cwd: opts.vaultRoot,
        timeout: 30000,
        windowsHide: true,
      },
    );
    return pass(
      "git.integrity",
      "local vault repository: no corruption",
      "git fsck passed",
    );
  } catch (error) {
    return fail(
      "git.integrity",
      "local vault repository: no corruption",
      "local vault git repository is corrupted; inspect with `git fsck --full --strict` before sync",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function checkRemoteGitIntegrity(
  opts: GitVerifyOptions,
): Promise<VerifyCheckResult> {
  try {
    const config = await (opts.configLoader ?? loadMemoryConfig)(opts.vaultRoot);
    const host = config.vps?.host?.trim();
    const installRoot = config.vps?.install_root?.trim();
    if (!host || !installRoot) {
      return warn(
        "git.integrity",
        "remote VPS repository: no corruption",
        "VPS integrity check unavailable: no vps config with host and install_root",
      );
    }

    const target = config.vps?.ssh_user?.trim()
      ? `${config.vps.ssh_user.trim()}@${host}`
      : host;
    const repoPath = `${installRoot.replace(/\/+$/, "")}/memory.git`;
    const result = await (opts.sshRunner ?? makeRealSshRunner()).run(target, {
      command: `git -C ${shellQuote(repoPath)} fsck --full --connectivity-only --no-dangling`,
      description: "verify remote VPS bare memory git repository integrity",
    });
    const output = [result.stdout.trim(), result.stderr.trim()]
      .filter((part) => part.length > 0)
      .join("\n");
    if (result.exitCode !== 0) {
      return fail(
        "git.integrity",
        "remote VPS repository: no corruption",
        "remote bare repository may be corrupted; inspect the VPS repo before sync",
        output || `ssh exited ${result.exitCode}`,
      );
    }
    return pass(
      "git.integrity",
      "remote VPS repository: no corruption",
      "remote git fsck passed",
    );
  } catch (error) {
    return fail(
      "git.integrity",
      "remote VPS repository: no corruption",
      "check vps config, SSH access, and remote bare repository path",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

async function resolveRemoteName(opts: GitVerifyOptions): Promise<string> {
  const explicit = opts.remoteName?.trim();
  if (explicit) return explicit;
  const config = await (opts.configLoader ?? loadMemoryConfig)(opts.vaultRoot);
  const configured = config.sync?.remote_name?.trim();
  return configured || "vps";
}
