import { useQuery } from "@tanstack/react-query";
import { API_BASE, ApiError } from "../lib/api.js";

export type GraphHealthStatus = "pass" | "warn" | "fail" | "n/a";

export interface GraphHealthMetric {
  id: string;
  label: string;
  value: number | string | null;
  unit?: string;
  threshold: { warn?: number; fail?: number; rule?: string };
  status: GraphHealthStatus;
  detail: string;
  topOffenders: Array<{
    path?: string;
    edge?: { from: string; to: string; type: string };
    pair?: [string, string];
    value?: number | string;
    note?: string;
  }>;
}

export interface GraphHealthReport {
  computedAt: string;
  metrics: GraphHealthMetric[];
  overallStatus: Exclude<GraphHealthStatus, "n/a"> | "n/a";
}

export function useGraphHealth() {
  return useQuery({
    queryKey: ["graph-health"],
    queryFn: fetchGraphHealth,
    staleTime: 25_000,
    refetchInterval: 60_000,
  });
}

async function fetchGraphHealth(): Promise<GraphHealthReport> {
  const url = new URL(`${API_BASE}/graph-health`, window.location.origin);
  const response = await fetch(url.toString());
  const body = await response.json().catch(() => null) as GraphHealthReport | { error?: string } | null;

  if (isGraphHealthReport(body)) return body;
  if (!response.ok) {
    throw new ApiError(response.status, body?.error ?? `${response.status} ${response.statusText}`);
  }
  throw new ApiError(response.status, "invalid graph health response");
}

function isGraphHealthReport(value: unknown): value is GraphHealthReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<GraphHealthReport>;
  return typeof report.computedAt === "string" &&
    Array.isArray(report.metrics) &&
    (report.overallStatus === "pass" ||
      report.overallStatus === "warn" ||
      report.overallStatus === "fail" ||
      report.overallStatus === "n/a");
}
