import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

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
}

export function useCompileState() {
  return useQuery({
    queryKey: ["compile-state"],
    queryFn: () => apiGet<CompileState>("/compile/state"),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 2_000 : false),
  });
}
