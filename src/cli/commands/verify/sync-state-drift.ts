import { readSyncStateFile } from "../../../sync/status.js";
import { makeRealCommandRunner, type CommandRunner } from "../../../sync/git-remote.js";
import { pass, warn, type CheckDescriptor, type VerifyCheckResult, type RunCheckOptions } from "./types.js";

export const syncStateDriftCheck: CheckDescriptor = {
  id: "sync.state-drift",
  label: "sync state matches actual git state",
  roles: ["operator"],
  run: (ctx) => checkSyncStateDrift(ctx),
};

export async function checkSyncStateDrift(
  ctx: RunCheckOptions & { runner?: CommandRunner },
): Promise<VerifyCheckResult> {
  const state = await readSyncStateFile(ctx.vaultRoot);
  if (state.conflicts_pending === 0) {
    return pass("sync.state-drift", "sync state matches actual git state");
  }

  const runner = ctx.runner ?? makeRealCommandRunner();
  const unmerged = await runner.run("git", ["ls-files", "-u"], { cwd: ctx.vaultRoot });

  if (unmerged.exitCode !== 0 || unmerged.stdout.trim().length > 0) {
    return pass(
      "sync.state-drift",
      `sync state reports ${state.conflicts_pending} conflict(s) and git confirms unmerged paths`,
    );
  }

  return warn(
    "sync.state-drift",
    "sync state records a conflict but git has no unmerged paths",
    `conflict_files: ${state.conflict_files.join(", ") || "(none listed)"}`,
    "run `memory sync` -- status will self-heal the stale conflict flag",
  );
}
