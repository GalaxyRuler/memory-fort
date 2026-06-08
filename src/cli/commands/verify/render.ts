import type { VerifyReport } from "./types.js";

export interface RenderableVerifyReport extends VerifyReport {
  passed: number;
  failed: number;
  warnings: number;
}

export function formatVerifyResult(result: RenderableVerifyReport): string {
  const lines = [`memory verify · ${result.startedAt}`, `Role: ${result.role}`, ""];
  for (const check of result.checks) {
    let marker: string;
    let suffix: string;
    if (check.status === "skip") {
      marker = "○";
      suffix = check.detail ? ` - ${check.detail} (skipped)` : " (skipped)";
    } else {
      marker =
        check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✗";
      suffix = check.suggestedFix
        ? ` - ${check.suggestedFix}`
        : check.detail
          ? ` - ${check.detail}`
          : "";
    }
    lines.push(`  ${marker} ${check.label}${suffix}`);
  }

  const passed = result.checks.filter((c) => c.status === "pass").length;
  const failed = result.checks.filter((c) => c.status === "fail").length;
  const warnings = result.checks.filter((c) => c.status === "warn").length;
  const skipped = result.checks.filter((c) => c.status === "skip").length;
  const total = result.checks.length;

  lines.push("");
  lines.push(
    `${passed}/${total} checks passed` +
      (failed > 0 ? `; ${failed} failed` : "") +
      (warnings > 0 ? `; ${warnings} ${warnings === 1 ? "warning" : "warnings"}` : "") +
      (skipped > 0 ? `; ${skipped} skipped` : "") +
      ".",
  );
  return `${lines.join("\n")}\n`;
}
