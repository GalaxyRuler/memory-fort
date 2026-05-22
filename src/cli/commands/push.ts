import {
  formatSyncSuccess,
  runSyncMode,
  type SyncOptions,
  type SyncResult,
} from "./sync.js";

export type PushOptions = SyncOptions;
export type PushResult = SyncResult;

export async function runPush(opts: PushOptions = {}): Promise<PushResult> {
  return runSyncMode("push", opts);
}

export function formatPushSuccess(result: PushResult, remoteName = "vps", branch = "main"): string {
  return formatSyncSuccess(result, remoteName, branch).replace(/^Sync/, "Push");
}
