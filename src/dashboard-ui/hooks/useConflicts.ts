import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export type ConflictReason = "duplicate-title" | "contradiction" | "stale-clone";

export interface ConflictPageSummary {
  path: string;
  title: string;
  updated: string | null;
  snippet: string;
}

export interface ConflictRecord {
  id: string;
  pageA: ConflictPageSummary;
  pageB: ConflictPageSummary;
  reason: ConflictReason;
}

export interface ConflictsResponse {
  conflicts: ConflictRecord[];
}

export function useConflicts() {
  return useQuery({
    queryKey: ["conflicts"],
    queryFn: () => apiGet<ConflictsResponse>("/conflicts"),
    staleTime: 30_000,
  });
}
