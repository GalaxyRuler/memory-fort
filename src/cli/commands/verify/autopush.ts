import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fail, pass, warn, type CheckDescriptor, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const autoPushErrorsCheck: CheckDescriptor = {
  id: "autopush.errors",
  label: "auto-push has no recent errors",
  roles: ["operator"],
  run: checkAutoPush,
};

export async function checkAutoPush(
  ctx: VerifyCheckContext,
): Promise<VerifyCheckResult> {
  const path = join(ctx.vaultRoot, "errors.log");
  if (!existsSync(path)) return pass("autopush.errors", "auto-push: no errors in last 24h");

  const lines = (await readFile(path, "utf-8"))
    .split(/\r?\n/)
    .filter((line) => line.includes("auto-push"))
    .filter((line) => !isPendingLockContention(line, ctx.vaultRoot))
    .slice(-100);
  const nowMs = ctx.now().getTime();
  const lastScheduledAt = await readLastScheduledAt(ctx.vaultRoot);
  const recentAges = lines.flatMap((line) => {
    const timestamp = parseTimestamp(line);
    if (timestamp !== null && lastScheduledAt !== null && timestamp <= lastScheduledAt) return [];
    return timestamp === null ? [] : [nowMs - timestamp];
  });
  const lastHour = recentAges.filter((age) => age >= 0 && age <= HOUR_MS).length;
  const lastDay = recentAges.filter((age) => age >= 0 && age <= DAY_MS).length;

  if (lastHour > 0) {
    return fail(
      "autopush.errors",
      `auto-push: ${lastHour} errors in last hour`,
      "run `memory sync` and inspect ~/.memory/errors.log",
    );
  }
  if (lastDay > 0) {
    return warn(
      "autopush.errors",
      `auto-push: ${lastDay} errors in last 24h`,
      "recent auto-push errors found",
    );
  }
  return pass("autopush.errors", "auto-push: no errors in last 24h");
}

function isPendingLockContention(line: string, vaultRoot: string): boolean {
  if (!/auto-push schedule failed: (?:EPERM|EACCES): .*open .*\.auto-push-pending\.lock/i.test(line)) {
    return false;
  }
  return existsSync(join(vaultRoot, ".auto-push-pending.lock"));
}

async function readLastScheduledAt(vaultRoot: string): Promise<number | null> {
  const path = join(vaultRoot, ".auto-push-last-scheduled");
  if (!existsSync(path)) return null;
  const parsed = Date.parse((await readFile(path, "utf-8")).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(line: string): number | null {
  const bracketed = /^\[([^\]]+)\]/.exec(line)?.[1];
  const inline = bracketed ?? /\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?/.exec(line)?.[0];
  if (!inline) return null;
  const parsed = Date.parse(inline);
  return Number.isFinite(parsed) ? parsed : null;
}
