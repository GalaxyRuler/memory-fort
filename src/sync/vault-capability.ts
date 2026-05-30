import { makeRealCommandRunner, type CommandRunner } from "./git-remote.js";
import { isGitRepo } from "./git-repo.js";

export interface VaultWriteCapability {
  writable: boolean;
  reason?: string;
}

export const READ_ONLY_MIRROR_REASON = "read-only mirror — run `memory dashboard` on your machine to make changes";

export async function getVaultWriteCapability(
  vaultRoot: string,
  runner: CommandRunner = makeRealCommandRunner(),
): Promise<VaultWriteCapability> {
  const writable = await isGitRepo(vaultRoot, runner);
  return writable ? { writable: true } : { writable: false, reason: READ_ONLY_MIRROR_REASON };
}
