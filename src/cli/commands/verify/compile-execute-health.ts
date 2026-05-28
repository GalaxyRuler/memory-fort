import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pass, warn, type CheckDescriptor, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

const ID = "compile.execute-health";
const LABEL = "compile execute health";

export const compileExecuteHealthCheck: CheckDescriptor = {
  id: ID,
  label: LABEL,
  roles: ["operator", "server"],
  run: checkCompileExecuteHealth,
};

export async function checkCompileExecuteHealth(
  opts: VerifyCheckContext,
): Promise<VerifyCheckResult> {
  const statePath = join(opts.vaultRoot, "state", "compile-state.json");
  if (!existsSync(statePath)) return pass(ID, LABEL, "no executed compile run recorded");

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(statePath, "utf-8"));
  } catch (error) {
    return warn(ID, LABEL, `compile state unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lastRun = typeof parsed === "object" && parsed !== null
    ? (parsed as { lastRun?: unknown }).lastRun
    : null;
  if (typeof lastRun !== "object" || lastRun === null || (lastRun as { execute?: unknown }).execute !== true) {
    return pass(ID, LABEL, "no executed compile run recorded");
  }

  const operationsApplied = readNumber((lastRun as Record<string, unknown>).operationsApplied);
  const operationsProposed = readNumber((lastRun as Record<string, unknown>).operationsProposed);
  if (operationsApplied === null || operationsProposed === null) {
    return warn(ID, LABEL, "last compile execute run did not record operation counts");
  }
  return pass(
    ID,
    LABEL,
    `compile execute applied ${operationsApplied} operation(s), proposed ${operationsProposed}`,
  );
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
