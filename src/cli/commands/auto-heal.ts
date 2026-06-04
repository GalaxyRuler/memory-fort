import { applyConfigPatch as defaultApplyConfigPatch } from "../../dashboard/config-patch.js";
import {
  readAutoHealStatus,
  runAutoHealTick,
  type AutoHealRunResult,
  type AutoHealStatus,
} from "../../retrieval/auto-heal.js";
import { loadMemoryConfig, type MemoryConfig } from "../../storage/config.js";
import { memoryRoot as defaultMemoryRoot } from "../../storage/paths.js";

export type AutoHealAction = "status" | "enable" | "disable" | "tick";

export type AutoHealCommandResult =
  | ({ kind: "status"; exitCode: number } & AutoHealStatus)
  | ({ kind: "run" } & AutoHealRunResult)
  | { kind: "config"; exitCode: number; enabled: boolean; applied: string[] };

export interface AutoHealCommandOptions {
  action: AutoHealAction;
  memoryRoot?: string;
  configLoader?: () => Promise<MemoryConfig>;
  applyConfigPatch?: typeof defaultApplyConfigPatch;
  tick?: (opts: { memoryRoot: string }) => Promise<AutoHealRunResult>;
}

export async function runAutoHealCommand(
  opts: AutoHealCommandOptions,
): Promise<AutoHealCommandResult> {
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  if (opts.action === "status") {
    const status = await readAutoHealStatus(root, {
      configLoader: opts.configLoader ?? (() => loadMemoryConfig(root)),
    });
    return { kind: "status", exitCode: 0, ...status };
  }
  if (opts.action === "tick") {
    return { kind: "run", ...await (opts.tick ?? ((input) => runAutoHealTick(input)) )({ memoryRoot: root }) };
  }

  const enabled = opts.action === "enable";
  const result = await (opts.applyConfigPatch ?? defaultApplyConfigPatch)(
    root,
    { auto_heal: { enabled } },
  );
  return {
    kind: "config",
    exitCode: 0,
    enabled,
    applied: result.applied,
  };
}

export function formatAutoHealResult(result: AutoHealCommandResult): string {
  if (result.kind === "config") {
    return [
      `Auto-heal ${result.enabled ? "enabled" : "disabled"}`,
      `Applied: ${result.applied.join(", ") || "none"}`,
      "",
    ].join("\n");
  }

  const lines = [
    `Enabled: ${result.enabled}`,
    `Daily spend: $${result.dailySpendUsd.toFixed(4)}`,
    `Daily cap: $${result.dailyBudgetUsd.toFixed(4)}`,
    `Next reset: ${result.nextReset}`,
  ];
  if (result.lastTick !== undefined) lines.push(`Last tick: ${result.lastTick ?? "never"}`);
  if (result.lastEmbed !== undefined) lines.push(`Last embed: ${result.lastEmbed ?? "never"}`);
  if (result.kind === "run") {
    lines.push(
      `Embedded: ${result.embedded}`,
      `Unchanged: ${result.unchanged}`,
      `Skipped pending: ${result.skippedPending}`,
      `Skipped budget: ${result.skippedBudget}`,
      `Errors: ${result.errors.length}`,
    );
    for (const error of result.errors.slice(0, 10)) {
      lines.push(`  ${error.path}: ${error.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
