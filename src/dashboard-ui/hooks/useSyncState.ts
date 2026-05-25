import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export interface CheckoutSyncState {
  lastCheckoutAt: string | null;
  lastCommit: string | null;
  status: "synced" | "stale" | "unknown";
}

export function useSyncState() {
  return useQuery({
    queryKey: ["sync-state"],
    queryFn: () => apiGet<CheckoutSyncState>("/sync-state"),
    staleTime: 15_000,
  });
}
