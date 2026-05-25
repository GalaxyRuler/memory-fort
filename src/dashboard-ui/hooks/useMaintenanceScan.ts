import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export interface MaintenancePageSummary {
  path: string;
  title: string;
  updated: string | null;
  confidence: number | null;
}

export interface MaintenanceScan {
  orphans: MaintenancePageSummary[];
  lowConfidence: MaintenancePageSummary[];
  stale: MaintenancePageSummary[];
  supersededDependents: MaintenancePageSummary[];
  pruneCandidates: MaintenancePageSummary[];
}

export function useMaintenanceScan() {
  return useQuery({
    queryKey: ["maintenance-scan"],
    queryFn: () => apiGet<MaintenanceScan>("/maintenance/scan"),
    staleTime: 30_000,
  });
}
