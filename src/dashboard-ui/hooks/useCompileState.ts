import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "../lib/api.js";

export type CompileStatus = "idle" | "running" | "completed" | "failed";

export interface CompileLastRun {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  pagesCompiled: number;
  digestPath: string;
}

export interface CompileState {
  status: CompileStatus;
  lastRun: CompileLastRun | null;
  schedule?: {
    scheduled: boolean;
    cadence: "daily" | "weekly" | "manual";
    nextRunAt: string | null;
  };
}

export interface CompileRunResponse {
  ok: true;
  summary: {
    rawIncluded: number;
    rawSkipped: number;
    outputPath: string;
  };
}

export function useCompileState() {
  return useQuery({
    queryKey: ["compile-state"],
    queryFn: () => apiGet<CompileState>("/compile/state"),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 2_000 : false),
  });
}

export function useRunCompileNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<CompileRunResponse>("/compile/run", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["compile-state"] });
      qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
}
