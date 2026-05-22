import {
  formatSyncSuccess,
  runSyncMode,
  type SyncOptions,
  type SyncResult,
} from "./sync.js";

export type PullOptions = SyncOptions;
export type PullResult = SyncResult;

export async function runPull(opts: PullOptions = {}): Promise<PullResult> {
  return runSyncMode("pull", opts);
}

export function formatPullSuccess(result: PullResult, remoteName = "vps", branch = "main"): string {
  return formatSyncSuccess(result, remoteName, branch).replace(/^Sync/, "Pull");
}
