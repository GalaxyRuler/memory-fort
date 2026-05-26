import type { VerifyReport } from "./types.js";

export interface RenderableVerifyReport extends VerifyReport {
  passed: number;
  failed: number;
  warnings: number;
}

export function formatVerifyResult(result: RenderableVerifyReport): string {
  const lines = [`memory verify · ${result.startedAt}`, ""];
  for (const check of result.checks) {
    const marker =
      check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✗";
    const suffix = check.suggestedFix
      ? ` - ${check.suggestedFix}`
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
