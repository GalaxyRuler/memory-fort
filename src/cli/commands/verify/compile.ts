import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fail, pass, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";
import type { VerifyDashboardStatus } from "./dashboard.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface CompileVerifyOptions extends VerifyCheckContext {
  dashboardStatus?: VerifyDashboardStatus | null;
}

export async function checkCompile(
  opts: CompileVerifyOptions,
): Promise<VerifyCheckResult> {
  const timestamp =
    opts.dashboardStatus?.lastCompile?.timestamp ??
    latestSuccessfulCompileHistory(opts.dashboardStatus) ??
    (await latestLocalCompile(opts.vaultRoot));

  if (!timestamp) {
    return fail(
      "compile.recent",
      "compile state recent",
      "run `memory compile`",
    );
  }

  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return fail(
      "compile.recent",
      "compile state recent",
      "run `memory compile`",
      `invalid timestamp ${timestamp}`,
    );
  }

  const ageMs = opts.now().getTime() - parsed;
  if (ageMs <= WEEK_MS) {
    return pass(
      "compile.recent",
      `compile last ran ${timestamp.slice(0, 10)}`,
    );
  }

  return fail(
    "compile.recent",
    `compile last ran ${timestamp.slice(0, 10)}`,
    "run `memory compile`",
  );
}

function latestSuccessfulCompileHistory(
  status: VerifyDashboardStatus | null | undefined,
): string | null {
  const history = status?.compile?.history;
  if (!Array.isArray(history)) return null;
  const success = history.findLast((entry) => entry.status === "success");
  return typeof success?.finishedAt === "string" ? success.finishedAt : null;
}

async function latestLocalCompile(vaultRoot: string): Promise<string | null> {
  const path = join(vaultRoot, "log.md");
  if (!existsSync(path)) return null;
  let latest: string | null = null;
  for (const line of (await readFile(path, "utf-8")).split(/\r?\n/)) {
    const match = /^## \[([^\]]+)\] compile \|/.exec(line);
    if (match) latest = match[1]!;
  }
  return latest;
}
