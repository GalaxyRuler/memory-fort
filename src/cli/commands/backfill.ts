import { atomicWrite } from "../../storage/atomic-write.js";
import { memoryRoot } from "../../storage/paths.js";
import { ClaudeCodeSniffer } from "../../sniffers/claude-code.js";
import { rawSessionRelPath, runSniffer, type RunSnifferResult } from "../../sniffers/run-sniffer.js";
import type { RawSession, Sniffer } from "../../sniffers/types.js";
import { join } from "node:path";
import { serializeFrontmatter } from "../../storage/frontmatter.js";
import {
  formatConsolidateResult,
  runConsolidate,
  type RunConsolidateOptions,
  type ConsolidateResult,
} from "./consolidate.js";

export interface BackfillOptions {
  from?: string;
  since?: string;
  plan?: boolean;
  apply?: boolean;
  now?: Date;
  sniffers?: Sniffer[];
  consolidateAfter?: boolean;
  consolidateFn?: (opts: RunConsolidateOptions) => Promise<ConsolidateResult>;
}

export interface BackfillResult {
  report: string;
  auditLogPath?: string;
  consolidate?: ConsolidateResult;
}

interface SnifferPlan {
  sniffer: Sniffer;
  sessions: RawSession[];
}

export async function runBackfill(opts: BackfillOptions = {}): Promise<BackfillResult> {
  if (opts.plan && opts.apply) {
    throw new Error("memory backfill: choose at most one of --plan or --apply");
  }
  const now = opts.now ?? new Date();
  const since = parseSince(opts.since, now);
  const sniffers = selectSniffers(opts.from, opts.sniffers ?? defaultSniffers());
  const plans = await collectPlans(sniffers, since);

  if (opts.plan) {
    return { report: formatBackfillPlan(plans, since) };
  }

  const results: RunSnifferResult[] = [];
  for (const plan of plans) {
    results.push(await runSniffer(plan.sniffer, { since }));
  }
  const auditLogPath = join(
    memoryRoot(),
    "wiki",
    ".audit",
    `backfill-${now.toISOString().replace(/[:.]/g, "-")}.md`,
  );
  await atomicWrite(auditLogPath, formatBackfillAudit(results, since, now));
  const consolidate = opts.consolidateAfter
    ? await (opts.consolidateFn ?? runConsolidate)({
        plan: false,
        corpusRoot: memoryRoot(),
        now,
      })
    : undefined;
  return {
    report: formatBackfillApply(results, since, auditLogPath, consolidate),
    auditLogPath,
    consolidate,
  };
}

function defaultSniffers(): Sniffer[] {
  return [new ClaudeCodeSniffer()];
}

function selectSniffers(from: string | undefined, sniffers: Sniffer[]): Sniffer[] {
  if (!from || from === "all") return sniffers;
  const selected = sniffers.find((sniffer) => sniffer.name === from);
  if (!selected) {
    throw new Error(`memory backfill: unknown sniffer "${from}"`);
  }
  return [selected];
}

async function collectPlans(sniffers: Sniffer[], since: Date): Promise<SnifferPlan[]> {
  const plans: SnifferPlan[] = [];
  for (const sniffer of sniffers) {
    if (!(await sniffer.available())) {
      plans.push({ sniffer, sessions: [] });
      continue;
    }
    const sessions: RawSession[] = [];
    for await (const session of sniffer.list({ since })) sessions.push(session);
    plans.push({ sniffer, sessions });
  }
  return plans;
}

function parseSince(value: string | undefined, now: Date): Date {
  if (!value) return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`memory backfill: invalid --since date "${value}"`);
  }
  return new Date(ms);
}

function formatBackfillPlan(plans: SnifferPlan[], since: Date): string {
  const lines = [`Memory backfill plan`, `since: ${since.toISOString()}`, ""];
  for (const plan of plans) {
    lines.push(`${plan.sniffer.name}: ${plan.sessions.length} ${plural(plan.sessions.length, "session")}`);
    for (const session of plan.sessions.slice(0, 5)) {
      lines.push(`- ${rawSessionRelPath(session)}`);
    }
    if (plan.sessions.length > 5) {
      lines.push(`- ... ${plan.sessions.length - 5} more`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatBackfillApply(
  results: RunSnifferResult[],
  since: Date,
  auditLogPath: string,
  consolidate?: ConsolidateResult,
): string {
  const written = results.reduce((sum, result) => sum + result.written.length, 0);
  const skipped = results.reduce((sum, result) => sum + result.skipped.length, 0);
  const lines = [
    "Memory backfill apply",
    `since: ${since.toISOString()}`,
    `written: ${written}`,
    `skipped: ${skipped}`,
    `audit: ${auditLogPath}`,
    "",
  ];
  for (const result of results) {
    lines.push(`${result.sniffer}: written ${result.written.length}, skipped ${result.skipped.length}`);
  }
  const report = `${lines.join("\n")}\n`;
  return consolidate
    ? `${report}\n${formatConsolidateResult(consolidate)}`
    : report;
}

function formatBackfillAudit(results: RunSnifferResult[], since: Date, now: Date): string {
  const lines = [
    "# backfill audit",
    "",
    `started: ${now.toISOString()}`,
    `since: ${since.toISOString()}`,
    "",
  ];
  for (const result of results) {
    lines.push(`## ${result.sniffer}`, "");
    for (const relPath of result.written) {
      lines.push(`- [write] ${relPath}`);
    }
    for (const skipped of result.skipped) {
      const target = skipped.relPath ? ` -> ${skipped.relPath}` : "";
      lines.push(`- [skip:${skipped.reason}] ${skipped.sessionId}${target}`);
    }
    if (result.written.length === 0 && result.skipped.length === 0) {
      lines.push("- [noop] no sessions matched");
    }
    lines.push("");
  }
  return serializeFrontmatter(
    {
      type: "references",
      title: "backfill audit",
      created: now.toISOString().slice(0, 10),
      updated: now.toISOString().slice(0, 10),
      status: "active",
      source: "backfill",
      cognitive_type: "semantic",
    },
    `${lines.join("\n")}\n`,
  );
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
