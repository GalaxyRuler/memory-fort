import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export type ConflictReason =
  | "duplicate-title"
  | "contradiction"
  | "stale-clone"
  | "derived-from-contradiction";

export interface ConflictPageSummary {
  path: string;
  title: string;
  updated: string | null;
  snippet: string;
}

export interface DirectConflictRecord {
  id: string;
  pageA: ConflictPageSummary;
  pageB: ConflictPageSummary;
  reason: Exclude<ConflictReason, "derived-from-contradiction">;
}

export interface DerivedConflictRecord {
  id: string;
  reason: "derived-from-contradiction";
  dependentPath: string;
  via: string[];
  rootContradictionId: string;
}

export type ConflictRecord = DirectConflictRecord | DerivedConflictRecord;

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
