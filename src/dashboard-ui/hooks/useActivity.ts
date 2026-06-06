import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export interface ActivityEvent {
  timestamp: string;
  source: "git" | "compile" | "sync" | "lint" | "errors";
  level: "info" | "warn" | "error";
  summary: string;
  details?: Record<string, unknown>;
}

export interface ActivityResponse {
  events: ActivityEvent[];
  nextCursor: string | null;
}

export function useActivity(limit = 20) {
  return useQuery({
    queryKey: ["activity", limit],
    queryFn: () => apiGet<ActivityResponse>("/activity", { limit }),
  });
}
