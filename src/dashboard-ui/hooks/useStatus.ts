import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export interface DashboardStatus {
  vaultRoot: string;
  repoHead: {
    sha: string;
    shortSha: string;
    subject: string;
    committedAt: string;
  } | null;
  counts: {
    wikiPages: number;
    rawObservations: number;
    crystals: number;
  };
  lastCompile: {
    timestamp: string;
    line: string;
  } | null;
  errorsLog: {
    sizeBytes: number;
    lastLine: string | null;
    isClean: boolean;
  };
  syncState: {
    lastSyncAttempt: string | null;
    lastSyncSuccess: string | null;
    pendingPushCount: number;
    conflictsPending: number;
    conflictFiles: string[];
    lastCheckoutAt?: string | null;
    isStale?: boolean;
  } | null;
  capabilities?: {
    writable: boolean;
    reason?: string;
  };
  generatedAt: string;
}

export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => apiGet<DashboardStatus>("/status"),
  });
}
