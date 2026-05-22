import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryRoot as defaultMemoryRoot, configPath } from "../../storage/paths.js";
import {
  addRemote,
  makeRealCommandRunner,
  pushToRemote,
  remoteHasCommits,
  type CommandRunner,
} from "../../sync/git-remote.js";
import { makeRealSshRunner, type SshRunner } from "../../sync/ssh-runner.js";

export interface SyncBootstrapOptions {
  memoryRoot?: string;
  remoteName?: string;
  sshHost?: string;
  vpsInstallRoot?: string;
  branch?: string;
  skipInitialPush?: boolean;
  commandRunner?: CommandRunner;
  sshRunner?: SshRunner;
}

export interface SyncBootstrapResult {
  remoteName: string;
  remoteUrl: string;
  remoteCreated: boolean;
  previousRemoteUrl: string | null;
  postReceiveInstalled: boolean;
  initialPushPerformed: boolean;
  branch: string;
}

interface VpsConfig {
  host?: string;
  installRoot?: string;
  sshUser?: string;
}

const DEFAULT_HOST = "srv1317946";
const DEFAULT_INSTALL_ROOT = "/root/memory-system";
const DEFAULT_REMOTE_NAME = "vps";
const DEFAULT_BRANCH = "main";
const DEFAULT_SSH_USER = "root";

async function readVpsConfig(): Promise<VpsConfig> {
  const path = configPath();
  if (!existsSync(path)) return {};
  const content = await readFile(path, "utf-8");
  const config: VpsConfig = {};
  const lines = content.split(/\r?\n/);
  let inVpsBlock = false;
  for (const line of lines) {
    if (/^vps:\s*(?:#.*)?$/.test(line)) {
      inVpsBlock = true;
      continue;
    }
    if (inVpsBlock && /^\S/.test(line)) break;
    if (!inVpsBlock) continue;
    const match = /^[ \t]+([A-Za-z_]+):\s*["']?([^"'\r\n#]+)["']?/.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = match[2]?.trim();
    if (!value) continue;
    if (key === "host") config.host = value;
    if (key === "install_root") config.installRoot = value;
    if (key === "ssh_user") config.sshUser = value;
  }
  return config;
}

async function isGitRepo(repoPath: string, runner: CommandRunner): Promise<boolean> {
  if (existsSync(join(repoPath, ".git"))) return true;
  const result = await runner.run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoPath });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function readPostReceiveTemplate(): Promise<string> {
  const local = resolve(process.cwd(), "templates", "vps", "post-receive.sh");
  if (existsSync(local)) return readFile(local, "utf-8");
  const bundled = resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates", "vps", "post-receive.sh");
  return readFile(bundled, "utf-8");
}

async function installPostReceiveHook(
  host: string,
  vpsInstallRoot: string,
  sshRunner: SshRunner,
): Promise<void> {
  const template = (await readPostReceiveTemplate()).replace(/\r\n/g, "\n");
  const hookPath = `${vpsInstallRoot}/memory.git/hooks/post-receive`;
  const upload = `cat > ${hookPath} <<'EOF'\n${template}\nEOF`;
  const uploadResult = await sshRunner.run(host, {
    command: upload,
    description: "install post-receive hook",
  });
  if (uploadResult.exitCode !== 0) {
    throw new Error(`install post-receive hook failed: ${uploadResult.stderr.trim() || uploadResult.stdout.trim()}`);
  }

  const chmodResult = await sshRunner.run(host, {
    command: `chmod +x ${hookPath}`,
    description: "make post-receive hook executable",
  });
  if (chmodResult.exitCode !== 0) {
    throw new Error(`chmod post-receive hook failed: ${chmodResult.stderr.trim() || chmodResult.stdout.trim()}`);
  }
}

export async function runSyncBootstrap(opts: SyncBootstrapOptions = {}): Promise<SyncBootstrapResult> {
  const config = await readVpsConfig();
  const repoPath = opts.memoryRoot ?? defaultMemoryRoot();
  const remoteName = opts.remoteName ?? DEFAULT_REMOTE_NAME;
  const sshHost = opts.sshHost ?? config.host ?? DEFAULT_HOST;
  const vpsInstallRoot = opts.vpsInstallRoot ?? config.installRoot ?? DEFAULT_INSTALL_ROOT;
  const branch = opts.branch ?? DEFAULT_BRANCH;
  const sshUser = config.sshUser ?? DEFAULT_SSH_USER;
  const remoteUrl = `${sshUser}@${sshHost}:${vpsInstallRoot}/memory.git`;
  const commandRunner = opts.commandRunner ?? makeRealCommandRunner();
  const sshRunner = opts.sshRunner ?? makeRealSshRunner();

  if (!existsSync(repoPath) || !(await isGitRepo(repoPath, commandRunner))) {
    throw new Error(`${repoPath} is not a git repo. Run memory init first.`);
  }

  const remote = await addRemote(repoPath, remoteName, remoteUrl, commandRunner);
  const sshCheck = await sshRunner.run(sshHost, {
    command: "true",
    description: "verify SSH",
  });
  if (sshCheck.exitCode !== 0) {
    throw new Error(`SSH verification failed for ${sshHost}: ${sshCheck.stderr.trim() || sshCheck.stdout.trim()}`);
  }

  await installPostReceiveHook(sshHost, vpsInstallRoot, sshRunner);
  const hasCommits = await remoteHasCommits(repoPath, remoteName, branch, commandRunner);
  let initialPushPerformed = false;
  if (!hasCommits && opts.skipInitialPush !== true) {
    await pushToRemote(repoPath, remoteName, branch, commandRunner);
    initialPushPerformed = true;
  }

  return {
    remoteName,
    remoteUrl,
    remoteCreated: remote.created,
    previousRemoteUrl: remote.previousUrl,
    postReceiveInstalled: true,
    initialPushPerformed,
    branch,
  };
}
