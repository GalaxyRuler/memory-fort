import { memoryRoot } from "../../storage/paths.js";
import { type VerifyDashboardStatus } from "./verify/dashboard.js";
import { ALL_CHECKS } from "./verify/registry.js";
import { formatVerifyResult } from "./verify/render.js";
import { detectRole } from "./verify/role.js";
import {
  type CheckDescriptor,
  type CheckResult,
  type CheckStatus,
  type VerifyRole,
  type VerifyCheckResult,
  type VerifyReport,
} from "./verify/types.js";

export { formatVerifyResult } from "./verify/render.js";
export type { CheckDescriptor, CheckResult, CheckStatus, VerifyCheckResult, VerifyReport, VerifyRole } from "./verify/types.js";

type CheckFn = () => Promise<VerifyCheckResult | VerifyCheckResult[]>;

export interface VerifyOptions {
  offline?: boolean;
  includeSearch?: boolean;
  vaultRoot?: string;
  dashboardUrl?: string;
  remoteName?: string;
  now?: () => Date;
  role?: VerifyRole;
  detectRoleFn?: () => VerifyRole;
  checkDescriptors?: CheckDescriptor[];
  checkFns?: CheckFn[];
}

export interface VerifyResult {
  startedAt: string;
  finishedAt: string;
  role: VerifyRole;
  overallStatus: CheckStatus;
  checks: VerifyCheckResult[];
  passed: number;
  failed: number;
  warnings: number;
  exitCode: 0 | 1;
}

export function parseVerifyRole(value: string | undefined): VerifyRole | undefined {
  if (value === undefined) return undefined;
  if (value === "operator" || value === "server") return value;
  throw new Error("invalid role; expected operator or server");
}

export async function runVerify(opts: VerifyOptions = {}): Promise<VerifyResult> {
  const now = opts.now ?? (() => new Date());
  const role = opts.role ?? opts.detectRoleFn?.() ?? detectRole();
  const vaultRoot = opts.vaultRoot ?? memoryRoot();
  const startedAt = now().toISOString();
  const checks = opts.checkFns
    ? await runInjectedChecks(opts.checkFns)
    : await runDescriptorChecks(
      opts.checkDescriptors ?? ALL_CHECKS,
      role,
      {
        vaultRoot,
        now,
        offline: opts.offline,
        includeSearch: opts.includeSearch ?? true,
        dashboardUrl: opts.dashboardUrl,
        remoteName: opts.remoteName,
      },
    );

  const passed = checks.filter((check) => check.status === "pass").length;
  const failed = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const finishedAt = now().toISOString();
  return {
    startedAt,
    finishedAt,
    role,
    overallStatus: overallStatus(checks),
    checks,
    passed,
    failed,
    warnings,
    exitCode: failed > 0 ? 1 : 0,
  };
}

async function runInjectedChecks(checkFns: CheckFn[]): Promise<VerifyCheckResult[]> {
  const checks: VerifyCheckResult[] = [];
  for (const checkFn of checkFns) {
    const started = performance.now();
    checks.push(
      ...[await checkFn()]
        .flat()
        .map((check) => withDuration(check, started)),
    );
  }
  return checks;
}

async function runDescriptorChecks(
  descriptors: CheckDescriptor[],
  role: VerifyRole,
  ctx: {
  vaultRoot: string;
  now: () => Date;
  offline?: boolean;
  includeSearch: boolean;
  dashboardUrl?: string;
  remoteName?: string;
},
): Promise<VerifyCheckResult[]> {
  const checks: VerifyCheckResult[] = [];
  let dashboardStatus: VerifyDashboardStatus | null = null;
  for (const descriptor of descriptors) {
    if (!descriptor.roles.includes(role)) continue;
    if (descriptor.id === "search.pipeline" && !ctx.includeSearch) continue;

    const result = await descriptor.run({
      ...ctx,
      dashboardStatus,
    });
    const flattened = [result].flat();
    checks.push(...flattened);
    if (descriptor.id === "dashboard.status") {
      dashboardStatus = readDashboardStatus(flattened[0]);
    }
  }
  return checks;
}

function readDashboardStatus(check: VerifyCheckResult | undefined): VerifyDashboardStatus | null {
  if (!check || !("statusBody" in check)) return null;
  const statusBody = check.statusBody;
  return statusBody && typeof statusBody === "object"
    ? statusBody as VerifyDashboardStatus
    : null;
}

function withDuration(check: VerifyCheckResult, started: number): VerifyCheckResult {
  return {
    ...check,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
  };
}

function overallStatus(checks: CheckResult[]): CheckStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}
