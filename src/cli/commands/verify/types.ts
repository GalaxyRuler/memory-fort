export type VerifyStatus = "pass" | "fail" | "warn";

export interface VerifyCheckResult {
  id: string;
  label: string;
  status: VerifyStatus;
  detail?: string;
  fix?: string;
}

export interface VerifyCheckContext {
  vaultRoot: string;
  now: () => Date;
  offline?: boolean;
}

export function pass(id: string, label: string, detail?: string): VerifyCheckResult {
  return { id, label, status: "pass", detail };
}

export function fail(
  id: string,
  label: string,
  fix?: string,
  detail?: string,
): VerifyCheckResult {
  return { id, label, status: "fail", fix, detail };
}

export function warn(
  id: string,
  label: string,
  detail?: string,
  fix?: string,
): VerifyCheckResult {
  return { id, label, status: "warn", detail, fix };
}
