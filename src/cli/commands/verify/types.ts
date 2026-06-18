export type CheckStatus = "pass" | "warn" | "fail" | "skip";
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
  role: VerifyRole;
  overallStatus: CheckStatus;
  checks: CheckResult[];
}

export type VerifyStatus = CheckStatus;
export type VerifyCheckResult = CheckResult;

export interface VerifyCheckContext {
  vaultRoot: string;
  now: () => Date;
  offline?: boolean;
  dashboardUrl?: string;
  remoteName?: string;
  runningProcessNames?: () => Promise<string[]>;
}

export interface RunCheckOptions extends VerifyCheckContext {
  dashboardStatus?: unknown;
}

export interface CheckDescriptor {
  id: string;
  label: string;
  roles: VerifyRole[];
  /** Hang-backstop timeout for this check (ms). Overrides the orchestrator default. */
  timeoutMs?: number;
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

export function skip(id: string, label: string, detail?: string): VerifyCheckResult {
  return { id, label, status: "skip", detail, durationMs: 0 };
}
