import { memoryRoot } from "../../storage/paths.js";
import { checkAutoPush } from "./verify/autopush.js";
import { checkClients } from "./verify/clients.js";
import { checkCompile } from "./verify/compile.js";
import { checkDashboard } from "./verify/dashboard.js";
import { checkEpisodicRelations } from "./verify/episodic-relations.js";
import { checkGitRemote } from "./verify/git.js";
import { formatVerifyResult } from "./verify/render.js";
import { checkSearch } from "./verify/search.js";
import {
  type CheckResult,
  type CheckStatus,
  type VerifyCheckResult,
  type VerifyReport,
} from "./verify/types.js";
import { checkVaultReadWrite } from "./verify/vault.js";

export { formatVerifyResult } from "./verify/render.js";
export type { CheckResult, CheckStatus, VerifyCheckResult, VerifyReport } from "./verify/types.js";

type CheckFn = () => Promise<VerifyCheckResult | VerifyCheckResult[]>;

export interface VerifyOptions {
  offline?: boolean;
  includeSearch?: boolean;
  now?: () => Date;
  checkFns?: CheckFn[];
}

export interface VerifyResult {
  startedAt: string;
  finishedAt: string;
  overallStatus: CheckStatus;
  checks: VerifyCheckResult[];
  passed: number;
  failed: number;
  warnings: number;
  exitCode: 0 | 1;
}

export async function runVerify(opts: VerifyOptions = {}): Promise<VerifyResult> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const checks = opts.checkFns
    ? await runInjectedChecks(opts.checkFns)
    : await runDefaultChecks({
        vaultRoot: memoryRoot(),
        now,
        offline: opts.offline,
        includeSearch: opts.includeSearch ?? true,
      });

  const passed = checks.filter((check) => check.status === "pass").length;
  const failed = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const finishedAt = now().toISOString();
  return {
    startedAt,
    finishedAt,
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

async function runDefaultChecks(ctx: {
  vaultRoot: string;
  now: () => Date;
  offline?: boolean;
  includeSearch: boolean;
}): Promise<VerifyCheckResult[]> {
  const checks: VerifyCheckResult[] = [];
  checks.push(await checkVaultReadWrite(ctx));
  checks.push(await checkGitRemote(ctx));

  const dashboard = await checkDashboard(ctx);
  checks.push(dashboard);

  if (ctx.includeSearch) {
    checks.push(await checkSearch(ctx));
  }
  checks.push(await checkEpisodicRelations(ctx));
  checks.push(...await checkClients(ctx));
  checks.push(await checkAutoPush(ctx));
  checks.push(
    await checkCompile({
      ...ctx,
      dashboardStatus: dashboard.statusBody ?? null,
    }),
  );
  return checks;
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
