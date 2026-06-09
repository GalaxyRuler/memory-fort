import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiPost } from "../lib/api.js";

export interface MaintenanceActionResult {
  ok: boolean;
  affected: number;
  paths: string[];
  error?: string;
}

export function useMaintenanceArchive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) =>
      apiPost<MaintenanceActionResult>("/maintenance/archive", { paths }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["maintenance-scan"] });
      void qc.invalidateQueries({ queryKey: ["wiki-index"] });
    },
  });
}

export function useMaintenanceDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) =>
      apiPost<MaintenanceActionResult>("/maintenance/delete", { paths }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["maintenance-scan"] });
      void qc.invalidateQueries({ queryKey: ["wiki-index"] });
    },
  });
}

export function useMaintenanceRecurate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) =>
      apiPost<MaintenanceActionResult>("/maintenance/recurate", { paths }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["maintenance-scan"] });
    },
  });
}
