import { memoryRoot } from "../../storage/paths.js";
import { checkAutoPush } from "./verify/autopush.js";
import { checkClients } from "./verify/clients.js";
import { checkCompile } from "./verify/compile.js";
import { checkDashboard } from "./verify/dashboard.js";
import { checkGitRemote } from "./verify/git.js";
import { checkSearch } from "./verify/search.js";
import { type VerifyCheckResult } from "./verify/types.js";
import { checkVaultReadWrite } from "./verify/vault.js";

export type { VerifyCheckResult } from "./verify/types.js";

type CheckFn = () => Promise<VerifyCheckResult | VerifyCheckResult[]>;

export interface VerifyOptions {
  offline?: boolean;
  now?: () => Date;
  checkFns?: CheckFn[];
}

export interface VerifyResult {
  startedAt: string;
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
      });

  const passed = checks.filter((check) => check.status === "pass").length;
  const failed = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  return {
    startedAt,
    checks,
    passed,
    failed,
    warnings,
    exitCode: failed > 0 ? 1 : 0,
  };
}

export function formatVerifyResult(result: VerifyResult): string {
  const lines = [`memory verify · ${result.startedAt}`, ""];
  for (const check of result.checks) {
    const marker =
      check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✗";
    const suffix = check.fix
      ? ` - ${check.fix}`
      : check.detail
        ? ` - ${check.detail}`
        : "";
    lines.push(`  ${marker} ${check.label}${suffix}`);
  }

  lines.push("");
  lines.push(
    `${result.passed}/${result.checks.length} checks passed` +
      (result.failed > 0 ? `; ${result.failed} failed` : "") +
      (result.warnings > 0
        ? `; ${result.warnings} ${result.warnings === 1 ? "warning" : "warnings"}`
        : "") +
      ".",
  );
  return `${lines.join("\n")}\n`;
}

async function runInjectedChecks(checkFns: CheckFn[]): Promise<VerifyCheckResult[]> {
  const checks: VerifyCheckResult[] = [];
  for (const checkFn of checkFns) {
    checks.push(...[await checkFn()].flat());
  }
  return checks;
}

async function runDefaultChecks(ctx: {
  vaultRoot: string;
  now: () => Date;
  offline?: boolean;
}): Promise<VerifyCheckResult[]> {
  const checks: VerifyCheckResult[] = [];
  checks.push(await checkVaultReadWrite(ctx));
  checks.push(await checkGitRemote(ctx));

  const dashboard = await checkDashboard(ctx);
  checks.push(dashboard);

  checks.push(await checkSearch(ctx));
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
