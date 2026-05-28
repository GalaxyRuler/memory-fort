import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fail, pass, type CheckDescriptor, type RunCheckOptions, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";
import type { VerifyDashboardStatus } from "./dashboard.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface CompileVerifyOptions extends VerifyCheckContext {
  dashboardStatus?: VerifyDashboardStatus | null;
}

export const compileRecentCheck: CheckDescriptor = {
  id: "compile.recent",
  label: "compile state recent",
  roles: ["operator", "server"],
  run: checkCompile,
};

export async function checkCompile(
  opts: RunCheckOptions,
): Promise<VerifyCheckResult> {
  const dashboardStatus = readDashboardStatus(opts.dashboardStatus);
  const timestamp =
    dashboardStatus?.lastCompile?.timestamp ??
    latestSuccessfulCompileHistory(dashboardStatus) ??
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
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.status === "success" && typeof entry.finishedAt === "string") {
      return entry.finishedAt;
    }
  }
  return null;
}

function readDashboardStatus(value: unknown): VerifyDashboardStatus | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as VerifyDashboardStatus;
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
