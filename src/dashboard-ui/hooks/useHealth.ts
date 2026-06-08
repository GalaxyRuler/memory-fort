import { useQuery } from "@tanstack/react-query";
import { API_BASE, ApiError } from "../lib/api.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
  suggestedFix?: string;
  durationMs: number;
}

export interface VerifyReport {
  startedAt: string;
  finishedAt: string;
  overallStatus: CheckStatus;
  checks: CheckResult[];
}

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });
}

async function fetchHealth(): Promise<VerifyReport> {
  const url = new URL(`${API_BASE}/health`, window.location.origin);
  const response = await fetch(url.toString());
  const body = await response.json().catch(() => null) as VerifyReport | { error?: string } | null;

  if (isVerifyReport(body)) return body;
  if (!response.ok) {
    throw new ApiError(response.status, body?.error ?? `${response.status} ${response.statusText}`);
  }
  throw new ApiError(response.status, "invalid health response");
}

function isVerifyReport(value: unknown): value is VerifyReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<VerifyReport>;
  return typeof report.startedAt === "string" &&
    typeof report.finishedAt === "string" &&
    (report.overallStatus === "pass" || report.overallStatus === "warn" || report.overallStatus === "fail") &&
    Array.isArray(report.checks);
}
