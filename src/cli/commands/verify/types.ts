export type CheckStatus = "pass" | "warn" | "fail";
export type VerifyRole = "operator" | "server";

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

export type VerifyStatus = CheckStatus;
export type VerifyCheckResult = CheckResult;

export interface VerifyCheckContext {
  vaultRoot: string;
  now: () => Date;
  offline?: boolean;
}

export type RunCheckOptions = VerifyCheckContext;

export interface CheckDescriptor {
  id: string;
  label: string;
  roles: VerifyRole[];
  run: (opts: RunCheckOptions) => Promise<CheckResult | CheckResult[]>;
}

export function pass(id: string, label: string, detail?: string): VerifyCheckResult {
  return { id, label, status: "pass", detail, durationMs: 0 };
}

export function fail(
  id: string,
  label: string,
  suggestedFix?: string,
  detail?: string,
): VerifyCheckResult {
  return { id, label, status: "fail", suggestedFix, detail, durationMs: 0 };
}

export function warn(
  id: string,
  label: string,
  detail?: string,
  suggestedFix?: string,
): VerifyCheckResult {
  return { id, label, status: "warn", detail, suggestedFix, durationMs: 0 };
}
