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
  label: "git repository integrity check",
  roles: ["operator"],
  timeoutMs: 120_000,
  deepTimeoutMs: 600_000,
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
      "set `sync.remote_name` in config.yaml to an existing remote, or add one with `git -C <vault> remote add <name> <url>` then run `memory sync`",
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
        "git repository integrity check skipped",
        "git fsck skipped (--offline); no integrity claim made",
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
  const deep = opts.deep === true;
  try {
    await (opts.execFile ?? execFileAsync)(
      "git",
      deep
        ? ["fsck", "--full", "--strict", "--no-dangling"]
        : ["fsck", "--full", "--connectivity-only", "--no-dangling"],
      {
        cwd: opts.vaultRoot,
        timeout: deep ? 300_000 : 30_000,
        windowsHide: true,
      },
    );
    return pass(
      "git.integrity",
      deep
        ? "local vault Git object integrity verified"
        : "local vault Git object connectivity verified",
      deep
        ? "strict full-object git fsck passed"
        : "connectivity-only git fsck passed; blob contents were not rehashed",
    );
  } catch (error) {
    return fail(
      "git.integrity",
      deep ? "local vault Git object integrity check failed" : "local vault Git object connectivity check failed",
      "inspect with `git fsck --full --strict` before sync",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function checkRemoteGitIntegrity(
  opts: GitVerifyOptions,
): Promise<VerifyCheckResult> {
  const deep = opts.deep === true;
  const fsckArgs = deep
    ? "--full --strict --no-dangling"
    : "--full --connectivity-only --no-dangling";
  try {
    const config = await (opts.configLoader ?? loadMemoryConfig)(opts.vaultRoot);
    const host = config.vps?.host?.trim();
    const installRoot = config.vps?.install_root?.trim();
    if (!host || !installRoot) {
      return warn(
        "git.integrity",
        deep ? "remote VPS Git object integrity check unavailable" : "remote VPS Git object connectivity check unavailable",
        "VPS integrity check unavailable: no vps config with host and install_root",
      );
    }

    const target = config.vps?.ssh_user?.trim()
      ? `${config.vps.ssh_user.trim()}@${host}`
      : host;
    const repoPath = `${installRoot.replace(/\/+$/, "")}/memory.git`;
    const result = await (opts.sshRunner ?? makeRealSshRunner()).run(target, {
      command: `git -C ${shellQuote(repoPath)} fsck ${fsckArgs}`,
      description: deep ? "deep-verify remote VPS Git objects" : "verify remote VPS Git object connectivity",
    });
    const output = [result.stdout.trim(), result.stderr.trim()]
      .filter((part) => part.length > 0)
      .join("\n");
    if (result.exitCode !== 0) {
      return fail(
        "git.integrity",
        deep
          ? "remote VPS Git object integrity check failed"
          : "remote VPS Git object connectivity check failed",
        "inspect the remote bare repository with `git fsck --full --strict` before sync",
        output || `ssh exited ${result.exitCode}`,
      );
    }
    return pass(
      "git.integrity",
      deep
        ? "remote VPS Git object integrity verified"
        : "remote VPS Git object connectivity verified",
      deep
        ? "remote strict full-object git fsck passed"
        : "remote connectivity-only git fsck passed; blob contents were not rehashed",
    );
  } catch (error) {
    return fail(
      "git.integrity",
      deep
        ? "remote VPS Git object integrity check failed"
        : "remote VPS Git object connectivity check failed",
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
