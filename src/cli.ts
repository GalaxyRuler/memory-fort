#!/usr/bin/env node
import { Command } from "commander";
import { printDebugLogBanner } from "./cli/debug-banner.js";
import { formatCompileExecuteSummary, runCompile, runCompileDrain } from "./cli/commands/compile.js";
import {
  formatConsolidateResult,
  runConsolidate,
} from "./cli/commands/consolidate.js";
import { formatConnectResult, runConnect } from "./cli/commands/connect.js";
import { formatDisconnectResult, runDisconnect } from "./cli/commands/disconnect.js";
import { runDoctor, formatDoctorResult } from "./cli/commands/doctor.js";
import { registerDashboardCommand } from "./cli/commands/dashboard.js";
import { registerEntityCommand } from "./cli/commands/entity.js";
import { registerEvalCommand } from "./cli/commands/eval.js";
import { runEvalRetrieval } from "./cli/commands/eval-retrieval.js";
import { runGrep, type GrepScope } from "./cli/commands/grep.js";
import { runInitOnboarding } from "./cli/commands/init-onboarding.js";
import { formatAutoHealResult, runAutoHealCommand, type AutoHealAction } from "./cli/commands/auto-heal.js";
import { runBackfill } from "./cli/commands/backfill.js";
import { runBackfillSource } from "./cli/commands/backfill-source.js";
import { runCompactRaw } from "./cli/commands/compact-raw.js";
import { formatCompressResult, runCompress } from "./cli/commands/compress.js";
import { formatCurateResult, runCurate } from "./cli/commands/curate.js";
import { runDecay } from "./cli/commands/decay.js";
import { formatDiscoverThreadsResult, runDiscoverThreads } from "./cli/commands/discover-threads.js";
import { formatReindexResult, runReindex } from "./cli/commands/reindex.js";
import { runImportAgentMemory } from "./cli/commands/import-agentmemory.js";
import { runInstall } from "./cli/commands/install.js";
import { formatNextSteps } from "./cli/commands/next-steps.js";
import { formatUninstallResult, runUninstall } from "./cli/commands/uninstall.js";
import { formatSupervisorJson, formatSupervisorResult, runInstallSupervisor, runSupervisorStatus } from "./cli/commands/supervisor.js";
import { runLint } from "./cli/commands/lint.js";
import { formatLinkRawResult, runLinkRaw } from "./cli/commands/link-raw.js";
import { runLog } from "./cli/commands/log.js";
import { runMigrateToNarrative } from "./cli/commands/migrate-to-narrative.js";
import { runPage } from "./cli/commands/page.js";
import { runRelinkAnchors } from "./cli/commands/relink-anchors.js";
import {
  formatAuditSummaryResult,
  formatAuditRotateResult,
  formatListEmbeddersResult,
  formatListLLMsResult,
  formatReindexEmbeddingsResult,
  formatReblessEmbeddingsResult,
  formatTestEmbedderResult,
  formatTestClassifierResult,
  formatTestLLMResult,
  runAuditSummary,
  runAuditRotate,
  runListEmbedders,
  runListLLMs,
  runReindexEmbeddings,
  runReblessEmbeddings,
  runTestEmbedder,
  runTestClassifier,
  runTestLLM,
} from "./cli/commands/provider.js";
import { runPrune } from "./cli/commands/prune.js";
import {
  formatRewriteImportedTimestampsResult,
  runRewriteImportedTimestamps,
} from "./cli/commands/rewrite-imported-timestamps.js";
import { runSearch } from "./cli/commands/search.js";
import { runStats, formatStatsResult } from "./cli/commands/stats.js";
import { formatSyncPromptsResult, runSyncPrompts } from "./cli/commands/sync-prompts.js";
import { runTailErrors } from "./cli/commands/tail-errors.js";
import { registerProcedureCommand } from "./cli/commands/procedure.js";
import { registerThreadCommand } from "./cli/commands/thread.js";
import { formatVerifyResult, parseVerifyRole, runVerify } from "./cli/commands/verify.js";
import {
  formatVerifyScheduleResult,
  runVerifySchedule,
  type VerifyScheduleAction,
  type VerifyScheduleShell,
} from "./cli/commands/verify-schedule.js";
import { formatWatchResult, runWatch } from "./cli/commands/watch.js";
import { memoryRoot } from "./storage/paths.js";

const program = new Command();

program
  .name("memory")
  .description("Cross-tool memory system CLI")
  .version("0.1.0")
  .addHelpText("after", `
Environment:
  MEMORY_ROOT    Path to the memory vault (default: ~/.memory)
  MEMORY_ROLE    Role hint for health checks (operator|server)
`);

registerEvalCommand(program);
registerDashboardCommand(program);
registerEntityCommand(program);
registerProcedureCommand(program);
registerThreadCommand(program);

program
  .command("eval-retrieval")
  .description("Run the checked-in retrieval gold set and report graph-spread lift")
  .option("--corpus <path>", "vault root (default: ~/.memory)")
  .option("--gold <path>", "path to retrieval-gold.jsonl (default: ./qa/retrieval-gold.jsonl)")
  .option("--k <list>", "comma-separated K values (default: 5,10)")
  .option("--limit <n>", "stop after N questions", parseInteger)
  .option("--json", "emit raw JSON")
  .action(async (opts: {
    corpus?: string;
    gold?: string;
    k?: string;
    limit?: number;
    json?: boolean;
  }) => {
    try {
      const result = await runEvalRetrieval(opts);
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    } catch (err) {
      console.error(`memory eval-retrieval failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Initialize ~/.memory/ with schema, index, log, config, and git")
  .option(
    "--reset",
    "destructive — archives existing ~/.memory/ before re-init",
  )
  .option("--vault <path>", "vault root (default: ~/.memory)")
  .option("--name <name>", "operator name for seeded schema variables")
  .option("--tools <csv>", "tools to wire: csv, all, or none")
  .option("--retrieval <mode>", "retrieval mode: lexical, voyage, openai, or ollama")
  .option("--dry-run", "print what would be created or modified without writing")
  .option("--yes", "skip interactive confirmation")
  .action(async (opts: {
    reset?: boolean;
    vault?: string;
    name?: string;
    tools?: string;
    retrieval?: string;
    dryRun?: boolean;
    yes?: boolean;
  }) => {
    try {
      const result = await runInitOnboarding({
        reset: opts.reset,
        vault: opts.vault,
        name: opts.name,
        tools: opts.tools,
        retrieval: opts.retrieval,
        dryRun: opts.dryRun,
        yes: opts.yes,
      });
      if (result.init.cancelled) {
        process.exit(1);
      }
      if (result.init.dryRun) {
        console.log("Dry run complete; no files written.");
        return;
      }
      console.log(`Initialized memory at ${result.init.root}`);
      console.log(`  created:    ${result.init.created.length} paths`);
      console.log(`  preserved:  ${result.init.preserved.length} paths`);
      if (result.init.archivedTo) {
        console.log(`  archived to: ${result.init.archivedTo}`);
      }
      if (result.tools.length > 0) {
        console.log(`  wired tools: ${result.tools.join(", ")}`);
      }
      process.stdout.write(formatNextSteps({ vault: result.vault }));
    } catch (err) {
      console.error(`memory init failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("install <platform>")
  .description("Install hooks + MCP for a platform (claude-code, codex, antigravity, hermes, pi, openclaw, opencoven, claude-desktop, vscode)")
  .option("--workspace <path>", "workspace path for clients that support workspace-scoped MCP")
  .option("--surface <surface>", "Antigravity surface: workspace | ide | both")
  .option("--apply", "install the Windows supervisor when platform is supervisor")
  .option("--remove", "remove the Windows supervisor when platform is supervisor")
  .option("--dry-run", "print what would be created or modified without writing")
  .option("--yes", "skip interactive confirmation")
  .option("--no-verify", "skip post-install memory verify")
  .action(async (
    platform: string,
    opts: { workspace?: string; surface?: "workspace" | "ide" | "both"; apply?: boolean; remove?: boolean; dryRun?: boolean; yes?: boolean; verify?: boolean },
  ) => {
    try {
      if (platform === "supervisor") {
        if ([opts.apply, opts.remove].filter(Boolean).length !== 1) {
          console.error("memory install supervisor: choose exactly one of --apply or --remove");
          process.exit(2);
        }
        const result = await runInstallSupervisor({ action: opts.remove ? "remove" : "apply" });
        process.stdout.write(formatSupervisorResult(result));
        process.exit(result.exitCode);
      }
      await runInstall(platform, { ...opts, noVerify: opts.verify === false });
    } catch (err) {
      console.error(`memory install ${platform} failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("uninstall <platform>")
  .description("Uninstall hooks + MCP for a platform (claude-code, codex, antigravity, hermes, pi, openclaw, claude-desktop, vscode)")
  .option("--workspace <path>", "workspace path for clients that support workspace-scoped MCP")
  .option("--dry-run", "print what would be removed without writing")
  .action(async (
    platform: string,
    opts: { workspace?: string; dryRun?: boolean },
  ) => {
    try {
      const result = await runUninstall(platform, opts);
      process.stdout.write(formatUninstallResult(result));
      process.exit(result.exitCode);
    } catch (err) {
      console.error(`memory uninstall ${platform} failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("auto-heal <action>")
  .description("Inspect or run bounded embedding auto-heal (status | enable | disable | tick)")
  .action(async (action: AutoHealAction) => {
    if (!["status", "enable", "disable", "tick"].includes(action)) {
      console.error("memory auto-heal: action must be status, enable, disable, or tick");
      process.exit(2);
    }
    try {
      const result = await runAutoHealCommand({ action });
      process.stdout.write(formatAutoHealResult(result));
      process.exit(result.exitCode);
    } catch (err) {
      console.error(`memory auto-heal ${action} failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

const supervisor = program
  .command("supervisor")
  .description("Inspect the Windows HKCU Run-key supervisor");

supervisor
  .command("status")
  .description("Query the Memory Fort dashboard HKCU Run-key autostart")
  .option("--json", "emit structured supervisor status JSON")
  .action(async (opts: { json?: boolean }) => {
    const result = await runSupervisorStatus();
    process.stdout.write(opts.json ? formatSupervisorJson(result) : formatSupervisorResult(result));
    process.exit(result.exitCode);
  });

program
  .command("connect [client]")
  .description("Install MCP/hooks for one client or every supported client")
  .option("--all", "install every supported client")
  .option("--workspace <path>", "workspace path for clients that support workspace-scoped MCP")
  .option("--dry-run", "print what would be created or modified without writing")
  .option("--yes", "skip interactive confirmation")
  .option("--no-verify", "skip post-connect memory verify")
  .action(async (
    client: string | undefined,
    opts: { all?: boolean; workspace?: string; dryRun?: boolean; yes?: boolean; verify?: boolean },
  ) => {
    try {
      const result = await runConnect({
        all: opts.all,
        client: client as never,
        workspace: opts.workspace,
        dryRun: opts.dryRun,
        yes: opts.yes,
        noVerify: opts.verify === false,
      });
      process.stdout.write(formatConnectResult(result));
      if (result.exitCode === 0 && !result.dryRun && !result.cancelled) {
        process.stdout.write(formatNextSteps({ vault: memoryRoot() }));
      }
      process.exit(result.exitCode);
    } catch (err) {
      console.error(`memory connect failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("disconnect [client]")
  .description("Remove MCP/hooks for one client or every supported client")
  .option("--all", "remove every supported client")
  .option("--workspace <path>", "workspace path for clients that support workspace-scoped MCP")
  .option("--dry-run", "print what would be removed without writing")
  .action(async (
    client: string | undefined,
    opts: { all?: boolean; workspace?: string; dryRun?: boolean },
  ) => {
    try {
      const result = await runDisconnect({
        all: opts.all,
        client: client as never,
        workspace: opts.workspace,
        dryRun: opts.dryRun,
      });
      process.stdout.write(formatDisconnectResult(result));
      process.exit(result.exitCode);
    } catch (err) {
      console.error(`memory disconnect failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("sync-prompts")
  .description("Refresh uncustomized vault prompts from bundled templates")
  .option("--plan", "preview prompt files that would be copied (default)")
  .option("--apply", "copy bundled templates over uncustomized vault prompts")
  .action(async (opts: { plan?: boolean; apply?: boolean }) => {
    if (opts.plan && opts.apply) {
      console.error("memory sync-prompts: choose at most one of --plan or --apply");
      process.exit(2);
    }
    try {
      const result = await runSyncPrompts({ apply: opts.apply, plan: opts.plan });
      process.stdout.write(formatSyncPromptsResult(result));
    } catch (err) {
      console.error(`memory sync-prompts failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("grep <pattern>")
  .description("Search memory (ripgrep over ~/.memory/raw/ and/or ~/.memory/wiki/)")
  .option("--scope <scope>", "raw | wiki | both (default: both)", "both")
  .option("-C, --context <n>", "lines of context (default: 2)", "2")
  .action((pattern: string, opts: { scope: string; context: string }) => {
    const scope = opts.scope as GrepScope;
    if (!["raw", "wiki", "both"].includes(scope)) {
      console.error(`Invalid --scope: ${scope}. Use raw, wiki, or both.`);
      process.exit(2);
    }
    const ctx = parseInt(opts.context, 10);
    if (!Number.isFinite(ctx) || ctx < 0) {
      console.error(`Invalid --context: ${opts.context}. Use a non-negative integer.`);
      process.exit(2);
    }
    const result = runGrep({ pattern, scope, contextLines: ctx });
    process.exit(result.exitCode);
  });

program
  .command("log <text>")
  .description("Append an observation to today's manual-source raw file")
  .option(
    "--tag <tag>",
    "tag for the observation (repeatable)",
    (value: string, prev: string[] = []) => [...prev, value],
  )
  .option("--confidence <n>", "confidence 0..1", parseFloat)
  .action(
    async (
      text: string,
      opts: { tag?: string[]; confidence?: number },
    ) => {
      try {
        const result = await runLog({
          text,
          tags: opts.tag,
          confidence: opts.confidence,
        });
        console.log(`Logged to ${result.path}`);
        console.log(`  session: ${result.sessionId}`);
        console.log(`  bytes:   ${result.bytesAppended}`);
      } catch (err) {
        const msg = (err as Error).message;
        console.error(msg);
        process.exit(msg.startsWith("memory log:") ? 2 : 1);
      }
    },
  );

program
  .command("link-raw")
  .description("Plan or apply automatic raw observation links to wiki entity pages")
  .option("--plan", "dry-run; do not write raw frontmatter")
  .option("--apply", "write mentions edges into orphan raw frontmatter")
  .option("--threshold <n>", "minimum similarity/title score (default: config auto_link.similarity_threshold or 0.65)", parseFloatOption)
  .option("--title-threshold <n>", "minimum lexical title score when embeddings are absent or degenerate (default: config auto_link.title_threshold or 0.55)", parseFloatOption)
  .option("--mass-collision-threshold <n>", "abort apply when this share of orphans maps to one target (default: config auto_link.mass_collision_threshold or 0.2)", parseFloatOption)
  .action(async (opts: {
    plan?: boolean;
    apply?: boolean;
    threshold?: number;
    titleThreshold?: number;
    massCollisionThreshold?: number;
  }) => {
    if (opts.plan && opts.apply) {
      console.error("memory link-raw: choose at most one of --plan or --apply");
      process.exit(2);
    }
    try {
      const result = await runLinkRaw({
        mode: opts.apply ? "apply" : "plan",
        threshold: opts.threshold,
        titleThreshold: opts.titleThreshold,
        massCollisionThreshold: opts.massCollisionThreshold,
      });
      process.stdout.write(formatLinkRawResult(result));
    } catch (err) {
      console.error(`memory link-raw failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("discover-threads")
  .description("Plan or apply relation-graph community thread proposals")
  .option("--plan", "dry-run; do not write draft thread pages")
  .option("--apply", "write draft thread pages under wiki/threads-proposed")
  .option("--min-cluster-size <n>", "minimum wiki entities per cluster (default: 3)", parseInteger)
  .option("--max-proposals <n>", "maximum proposals to return/write (default: 10)", parseInteger)
  .action(async (opts: { plan?: boolean; apply?: boolean; minClusterSize?: number; maxProposals?: number }) => {
    if (opts.plan && opts.apply) {
      console.error("memory discover-threads: choose at most one of --plan or --apply");
      process.exit(2);
    }
    try {
      const result = await runDiscoverThreads({
        mode: opts.apply ? "apply" : "plan",
        minClusterSize: opts.minClusterSize,
        maxProposals: opts.maxProposals,
      });
      process.stdout.write(formatDiscoverThreadsResult(result));
    } catch (err) {
      console.error(`memory discover-threads failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("compress")
  .description("Compress raw sessions once into importance-scored fact bundles")
  .option("--plan", "preview sessions that would be compressed (default)")
  .option("--apply", "write compressed facts and advance compression watermarks")
  .option("--drain", "keep compressing bounded batches until no uncompressed sessions remain")
  .option("--max-sessions <n>", "max raw sessions per batch (default: 25)", parseInteger)
  .action(async (opts: {
    plan?: boolean;
    apply?: boolean;
    drain?: boolean;
    maxSessions?: number;
  }) => {
    try {
      if (opts.plan && opts.apply) {
        throw new Error("--plan and --apply are mutually exclusive");
      }
      if (opts.drain && !opts.apply) {
        throw new Error("--drain requires --apply");
      }
      if (!opts.drain) {
        const result = await runCompress({
          apply: opts.apply,
          maxSessions: opts.maxSessions,
        });
        process.stdout.write(formatCompressResult(result));
        return;
      }
      let totalCompressed = 0;
      let totalFacts = 0;
      let totalFailed = 0;
      let pass = 0;
      while (true) {
        pass += 1;
        const result = await runCompress({
          apply: true,
          maxSessions: opts.maxSessions,
        });
        totalCompressed += result.summary.compressed;
        totalFacts += result.summary.factsWritten;
        totalFailed += result.summary.failed;
        console.error(`compress pass ${pass}: compressed ${result.summary.compressed}, failed ${result.summary.failed}, skipped ${result.summary.skipped}, facts ${result.summary.factsWritten}`);
        if (result.summary.compressed === 0) break;
      }
      process.stdout.write(`Memory compress drain complete\n  passes:       ${pass}\n  compressed:   ${totalCompressed}\n  failed:       ${totalFailed}\n  facts written: ${totalFacts}\n`);
    } catch (err) {
      console.error(`memory compress failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("compile")
  .description("Assemble an LLM prompt from raw observations and wiki context")
  .option("--since <iso>", "ISO date/timestamp cutoff for raw files")
  .option("--per-file-max-bytes <n>", "max raw bytes per file", parseInteger)
  .option("--total-max-bytes <n>", "max total raw bytes", parseInteger)
  .option("-o, --output <path>", "also write the assembled prompt to a file")
  .option("--execute", "send the prompt to the configured LLM and apply grounded compile-ops")
  .option("--plan", "with --execute, preview compile-ops without writing")
  .option("--drain", "with --execute, keep compiling until no eligible raw tails remain")
  .option("--max-passes <n>", "maximum drain passes (default: 50)", parseInteger)
  .option("--reset-watermark [glob]", "clear consumed raw-file watermarks before compiling")
  .action(
    async (opts: {
      since?: string;
      perFileMaxBytes?: number;
      totalMaxBytes?: number;
      output?: string;
      execute?: boolean;
      plan?: boolean;
      drain?: boolean;
      maxPasses?: number;
      resetWatermark?: string | boolean;
    }) => {
      try {
        if (opts.drain) {
          const result = await runCompileDrain({
            since: opts.since,
            perFileMaxBytes: opts.perFileMaxBytes,
            totalMaxBytes: opts.totalMaxBytes,
            outputPath: opts.output,
            execute: opts.execute ?? false,
            plan: opts.plan,
            maxPasses: opts.maxPasses,
            resetWatermark: opts.resetWatermark,
            onProgress: (line) => console.error(line),
          });
          console.error(`Compile drain ${result.stopReason === "empty" ? "complete" : "stopped at max passes"}`);
          console.error(`  passes:              ${result.passes.length}`);
          console.error(`  raw files included:  ${result.totalRawFilesIncluded}`);
          console.error(`  watermarks advanced: ${result.totalWatermarksAdvanced}`);
          console.error(`  raw files remaining: ${result.rawFilesRemaining}`);
          console.error(`  raw bytes remaining: ${result.rawBytesRemaining}`);
          return;
        }
        const result = await runCompile({
          since: opts.since,
          perFileMaxBytes: opts.perFileMaxBytes,
          totalMaxBytes: opts.totalMaxBytes,
          outputPath: opts.output,
          execute: opts.execute,
          plan: opts.plan,
          resetWatermark: opts.resetWatermark,
        });
        if (opts.execute && result.execution) {
          console.error(`Compile ${result.execution.mode} complete`);
          console.error(`  watermark mode:     ${result.watermarkMode}`);
          if (result.watermarkReset) {
            console.error(`  watermark reset:    ${result.watermarkReset.cleared} cleared${result.watermarkReset.pattern ? ` (${result.watermarkReset.pattern})` : ""}`);
          }
          if (result.watermarksAdvanced.length > 0) {
            console.error(`  watermarks advanced: ${result.watermarksAdvanced.length}`);
          }
          for (const line of formatCompileExecuteSummary(result)) {
            console.error(`  ${line}`);
          }
          if (result.execution.planned.length > 0) {
            console.error(`  operations planned: ${result.execution.planned.length}`);
          }
          console.error(`  pages rewritten:    ${result.execution.pagesRewritten}`);
          console.error(`  pages updated:      ${result.execution.pagesUpdated}`);
          console.error(`  facts extracted:    ${result.execution.factsExtracted}`);
          if (result.execution.extractionTokensUsed) {
            console.error(`  extraction tokens:  ${result.execution.extractionTokensUsed.total} total (${result.execution.extractionTokensUsed.prompt} prompt, ${result.execution.extractionTokensUsed.completion} completion)`);
          }
          if (result.execution.rewriteTokensUsed) {
            console.error(`  rewrite tokens:     ${result.execution.rewriteTokensUsed.total} total (${result.execution.rewriteTokensUsed.prompt} prompt, ${result.execution.rewriteTokensUsed.completion} completion)`);
          }
          if (result.indexRebuild) {
            console.error(`  index rebuilt:      ${result.indexRebuild.changed ? "yes" : "unchanged"} (${result.indexRebuild.entries} entries)`);
          }
          if (result.execution.outcomes.length > 0) {
            console.error("  operation outcomes:");
            for (const item of result.execution.outcomes) {
              const label = item.converted
                ? `converted ${item.converted.replace(": target already existed", "")}`
                : item.outcome;
              const reason = item.reason ?? (item.converted ? "target already existed" : undefined);
              console.error(`    - ${label}: ${item.path}${reason ? ` (${reason})` : ""}`);
            }
          }
        } else if (opts.output) {
          console.error(`Compile prompt written to ${opts.output}`);
          console.error(`  watermark mode:     ${result.watermarkMode}`);
          if (result.watermarkReset) {
            console.error(`  watermark reset:    ${result.watermarkReset.cleared} cleared${result.watermarkReset.pattern ? ` (${result.watermarkReset.pattern})` : ""}`);
          }
          console.error(`  raw files included: ${result.rawFilesIncluded.length}`);
          console.error(`  raw files skipped:  ${result.rawFilesSkipped.length}`);
          console.error(`  since cutoff:       ${result.sinceCutoff}`);
          if (result.truncatedAtTotalCap) {
            console.error("  WARNING: total-cap reached; some raws excluded");
          }
        } else {
          process.stdout.write(result.prompt);
        }
      } catch (err) {
        console.error(`memory compile failed: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );

program
  .command("reindex")
  .description("Regenerate index.md deterministically from canonical wiki pages")
  .option("--plan", "preview whether index.md would change without writing")
  .action(async (opts: { plan?: boolean }) => {
    try {
      const result = await runReindex({ plan: opts.plan });
      process.stdout.write(formatReindexResult(result, { plan: opts.plan }));
    } catch (err) {
      console.error(`memory reindex failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("curate [page]")
  .description("Curate-merge a bloated wiki page into one coherent article")
  .option("--plan", "preview the rewrite operation without writing (default)")
  .option("--apply", "apply the curated rewrite through the content-preservation guard")
  .option("--all", "plan/apply pages over the dated-section threshold")
  .option("--section-threshold <n>", "dated update section threshold for --all (default: 8)", parseInteger)
  .option("--refresh", "re-feed raw observations for the page through novelty judgment")
  .option("--refresh-days <n>", "raw observation lookback for --refresh (default: 14)", parseInteger)
  .action(async (page: string | undefined, opts: {
    plan?: boolean;
    apply?: boolean;
    all?: boolean;
    sectionThreshold?: number;
    refresh?: boolean;
    refreshDays?: number;
  }) => {
    try {
      if (opts.plan && opts.apply) {
        throw new Error("--plan and --apply are mutually exclusive");
      }
      const result = await runCurate({
        target: page,
        all: opts.all,
        apply: opts.apply,
        plan: opts.plan,
        sectionThreshold: opts.sectionThreshold,
        refresh: opts.refresh,
        refreshDays: opts.refreshDays,
      });
      process.stdout.write(formatCurateResult(result));
    } catch (err) {
      console.error(`memory curate failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("compact-raw")
  .description("Shrink oversized raw ToolUse payloads with archive-first middle-out compaction")
  .option("--plan", "report reclaimable raw bytes without rewriting (default)")
  .option("--apply", "archive originals, rewrite compacted raws, and commit the vault mutation")
  .option("--max-input-bytes <n>", "max ToolUse input bytes after compaction (default: 8192)", parseInteger)
  .option("--max-output-bytes <n>", "max ToolUse output bytes after compaction (default: 8192)", parseInteger)
  .action(async (opts: {
    plan?: boolean;
    apply?: boolean;
    maxInputBytes?: number;
    maxOutputBytes?: number;
  }) => {
    try {
      if (opts.plan && opts.apply) {
        throw new Error("--plan and --apply are mutually exclusive");
      }
      const result = await runCompactRaw({
        mode: opts.apply ? "apply" : "plan",
        maxInputBytes: opts.maxInputBytes,
        maxOutputBytes: opts.maxOutputBytes,
      });
      process.stdout.write(result.report);
    } catch (err) {
      console.error(`memory compact-raw failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("consolidate")
  .description("Link raw episodic observations to existing wiki pages")
  .option("--plan", "dry-run proposed relations")
  .option("--apply", "write typed relations to raw observations")
  .option("--force", "process observations that already have relations")
  .option("--min-confidence <n>", "minimum match confidence (default: 0.6)", parseFloat)
  .option("--max-links-per-observation <n>", "max links per observation (default: 5)", parseInteger)
  .action(async (opts: {
    plan?: boolean;
    apply?: boolean;
    force?: boolean;
    minConfidence?: number;
    maxLinksPerObservation?: number;
  }) => {
    if ([opts.plan, opts.apply].filter(Boolean).length !== 1) {
      console.error("memory consolidate: choose exactly one of --plan or --apply");
      process.exit(2);
    }
    try {
      const result = await runConsolidate({
        plan: Boolean(opts.plan),
        apply: opts.apply,
        force: opts.force,
        minConfidence: opts.minConfidence,
        maxLinksPerObservation: opts.maxLinksPerObservation,
      });
      process.stdout.write(formatConsolidateResult(result));
    } catch (err) {
      console.error(`memory consolidate failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("lint")
  .description("Assemble an LLM lint prompt or run programmatic wiki checks")
  .option("--checks-only", "run programmatic checks instead of prompt mode")
  .option("--stale-days <n>", "stale-page threshold in days", parseInteger)
  .action(
    async (opts: {
      checksOnly?: boolean;
      staleDays?: number;
    }) => {
      try {
        const result = await runLint({
          checksOnly: opts.checksOnly,
          staleDays: opts.staleDays,
        });
        if (result.mode === "prompt") {
          process.stdout.write(result.prompt);
        } else {
          process.stdout.write(result.report);
          process.exit(result.hasBlockingIssues ? 1 : 0);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    },
  );

program
  .command("page <target>")
  .description("Pretty-print a wiki page with resolved relations and inbound references")
  .option("--no-inbound", "skip the inbound-references scan")
  .action(async (target: string, opts: { inbound?: boolean }) => {
    try {
      const noInbound = opts.inbound === false;
      const result = await runPage(target, { noInbound });
      process.stdout.write(result.rendered);
    } catch (err) {
      console.error(`memory page failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("prune")
  .description("Plan, archive, or restore prune candidates")
  .option("--plan", "dry-run report of prune candidates")
  .option("--apply", "archive prune candidates")
  .option("--restore <path>", "restore an archived path")
  .action(async (opts: { plan?: boolean; apply?: boolean; restore?: string }) => {
    const modes = [opts.plan, opts.apply, opts.restore !== undefined].filter(Boolean);
    if (modes.length !== 1) {
      console.error("memory prune: choose exactly one of --plan, --apply, or --restore <path>");
      process.exit(2);
    }
    try {
      const result = await runPrune(
        opts.restore
          ? { mode: "restore", path: opts.restore }
          : { mode: opts.apply ? "apply" : "plan" },
      );
      process.stdout.write(result.report);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("decay")
  .description("Decay stale narrative memory record strength and archive expired pages")
  .option("--plan", "dry-run report of decay/archive candidates")
  .option("--apply", "apply strength decay and archive expired pages")
  .action(async (opts: { plan?: boolean; apply?: boolean }) => {
    const modes = [opts.plan, opts.apply].filter(Boolean);
    if (modes.length !== 1) {
      console.error("memory decay: choose exactly one of --plan or --apply");
      process.exit(2);
    }
    try {
      const result = await runDecay({ mode: opts.apply ? "apply" : "plan" });
      process.stdout.write(result.report);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("migrate-to-narrative")
  .description("Plan or apply migration of structured knowledge pages into narrative records")
  .option("--plan", "dry-run report of migration candidates")
  .option("--apply", "rewrite migration candidates through the narrative record prompt")
  .action(async (opts: { plan?: boolean; apply?: boolean }) => {
    const modes = [opts.plan, opts.apply].filter(Boolean);
    if (modes.length !== 1) {
      console.error("memory migrate-to-narrative: choose exactly one of --plan or --apply");
      process.exit(2);
    }
    try {
      const result = await runMigrateToNarrative({ mode: opts.apply ? "apply" : "plan" });
      process.stdout.write(result.report);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("relink-anchors")
  .description("Plan or apply deterministic restoration of dropped rewrite anchors")
  .option("--plan", "dry-run report of anchor restorations")
  .option("--apply", "restore anchors and archive the previous page version")
  .option("--page <slug>", "restrict to one page path or slug")
  .action(async (opts: { plan?: boolean; apply?: boolean; page?: string }) => {
    const modes = [opts.plan, opts.apply].filter(Boolean);
    if (modes.length !== 1) {
      console.error("memory relink-anchors: choose exactly one of --plan or --apply");
      process.exit(2);
    }
    try {
      const result = await runRelinkAnchors({
        mode: opts.apply ? "apply" : "plan",
        page: opts.page,
      });
      process.stdout.write(result.report);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

const provider = program
  .command("provider")
  .description("Inspect and test embedding and LLM providers");

provider
  .command("list-embedders")
  .description("List supported embedding providers and current configuration")
  .action(async () => {
    try {
      process.stdout.write(formatListEmbeddersResult(await runListEmbedders()));
    } catch (err) {
      console.error(`memory provider list-embedders failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

provider
  .command("test-embedder")
  .description("Run a one-call embedding smoke test")
  .option("--provider <provider>", "voyage | openai | ollama")
  .action(async (opts: { provider?: "voyage" | "openai" | "ollama" }) => {
    if (opts.provider && !["voyage", "openai", "ollama"].includes(opts.provider)) {
      console.error("memory provider test-embedder: --provider must be voyage, openai, or ollama");
      process.exit(2);
    }
    const result = await runTestEmbedder({ provider: opts.provider });
    process.stdout.write(formatTestEmbedderResult(result));
    process.exit(result.exitCode);
  });

provider
  .command("reindex-embeddings")
  .description("Plan or apply a full embedding reindex for the active provider")
  .option("--plan", "report what would be re-embedded")
  .option("--apply", "re-embed the full vault")
  .action(async (opts: { plan?: boolean; apply?: boolean }) => {
    if ([opts.plan, opts.apply].filter(Boolean).length !== 1) {
      console.error("memory provider reindex-embeddings: choose exactly one of --plan or --apply");
      process.exit(2);
    }
    try {
      const result = await runReindexEmbeddings({
        mode: opts.apply ? "apply" : "plan",
      });
      process.stdout.write(formatReindexEmbeddingsResult(result));
      process.exit(result.exitCode);
    } catch (err) {
      console.error(`memory provider reindex-embeddings failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

provider
  .command("rebless-embeddings")
  .description("Update stale embedding hashes for proven redaction-only rewrites without re-embedding")
  .requiredOption("--baseline-root <path>", "vault root containing the pre-redaction markdown bytes")
  .option("--plan", "report reblessable records without writing")
  .option("--apply", "update matching sidecar hashes")
  .action(async (opts: { baselineRoot: string; plan?: boolean; apply?: boolean }) => {
    if ([opts.plan, opts.apply].filter(Boolean).length !== 1) {
      console.error("memory provider rebless-embeddings: choose exactly one of --plan or --apply");
      process.exit(2);
    }
    try {
      const result = await runReblessEmbeddings({
        baselineRoot: opts.baselineRoot,
        mode: opts.apply ? "apply" : "plan",
      });
      process.stdout.write(formatReblessEmbeddingsResult(result));
      process.exit(result.exitCode);
    } catch (err) {
      console.error(`memory provider rebless-embeddings failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

provider
  .command("list-llms")
  .description("List supported LLM providers and current configuration")
  .action(async () => {
    try {
      process.stdout.write(formatListLLMsResult(await runListLLMs()));
    } catch (err) {
      console.error(`memory provider list-llms failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

provider
  .command("test-llm")
  .description("Run a one-call LLM smoke test and audit it")
  .option("--provider <provider>", "openrouter | ollama")
  .action(async (opts: { provider?: "openrouter" | "ollama" }) => {
    if (opts.provider && !["openrouter", "ollama"].includes(opts.provider)) {
      console.error("memory provider test-llm: --provider must be openrouter or ollama");
      process.exit(2);
    }
    const result = await runTestLLM({ provider: opts.provider });
    process.stdout.write(formatTestLLMResult(result));
    process.exit(result.exitCode);
  });

provider
  .command("test-classifier <query>")
  .description("Run a one-query retrieval intent classification smoke test")
  .action(async (query: string) => {
    try {
      const result = await runTestClassifier({ query });
      process.stdout.write(formatTestClassifierResult(result));
      process.exit(result.exitCode);
    } catch (err) {
      console.error(`memory provider test-classifier failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

provider
  .command("audit-summary")
  .description("Summarize recent LLM audit calls")
  .option("--days <n>", "days to include (default: 7)", parseInteger)
  .action(async (opts: { days?: number }) => {
    try {
      const result = await runAuditSummary({ days: opts.days });
      process.stdout.write(formatAuditSummaryResult(result));
      process.exit(result.exitCode);
    } catch (err) {
      console.error(`memory provider audit-summary failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

provider
  .command("audit-rotate")
  .description("Archive old wiki/.audit logs")
  .option("--plan", "report files that would be archived")
  .option("--apply", "archive old audit logs")
  .option("--keep-days <n>", "days to keep per audit log family (default: 30)", parseInteger)
  .action(async (opts: { plan?: boolean; apply?: boolean; keepDays?: number }) => {
    if (opts.plan && opts.apply) {
      console.error("memory provider audit-rotate: choose at most one of --plan or --apply");
      process.exit(2);
    }
    try {
      const result = await runAuditRotate({
        mode: opts.apply ? "apply" : "plan",
        keepDays: opts.keepDays,
      });
      process.stdout.write(formatAuditRotateResult(result));
      process.exit(result.exitCode);
    } catch (err) {
      console.error(`memory provider audit-rotate failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("import-agentmemory")
  .description("Plan or apply a one-shot migration from legacy agentmemory data")
  .requiredOption("--from <path>", "path to agentmemory data/ or state_store.db/")
  .option("--plan", "dry-run report")
  .option("--apply", "write imported pages and audit log")
  .option("--consolidate-after", "run memory consolidate --apply after import completes")
  .action(async (opts: { from: string; plan?: boolean; apply?: boolean; consolidateAfter?: boolean }) => {
    const modes = [opts.plan, opts.apply].filter(Boolean);
    if (modes.length !== 1) {
      console.error("memory import-agentmemory: choose exactly one of --plan or --apply");
      process.exit(2);
    }
    try {
      const result = await runImportAgentMemory({
        from: opts.from,
        mode: opts.apply ? "apply" : "plan",
        consolidateAfter: opts.consolidateAfter,
      });
      process.stdout.write(result.report);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("rewrite-imported-timestamps")
  .description("Add observed_at dates to imported agentmemory files when original keys contain UUIDv7 timestamps")
  .action(async () => {
    try {
      const result = await runRewriteImportedTimestamps();
      process.stdout.write(formatRewriteImportedTimestampsResult(result));
    } catch (err) {
      console.error(`memory rewrite-imported-timestamps failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("backfill")
  .description("Import historical sessions from supported local client stores")
  .option("--from <client>", "client to backfill (default: all)")
  .option("--since <date>", "oldest session mtime to include (default: 30 days ago)")
  .option("--plan", "dry-run report")
  .option("--apply", "apply backfill explicitly (default when --plan is absent)")
  .option("--consolidate-after", "run memory consolidate --apply after backfill completes")
  .action(async (opts: { from?: string; since?: string; plan?: boolean; apply?: boolean; consolidateAfter?: boolean }) => {
    try {
      const result = await runBackfill({
        from: opts.from,
        since: opts.since,
        plan: opts.plan,
        apply: opts.apply,
        consolidateAfter: opts.consolidateAfter,
      });
      process.stdout.write(result.report);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("backfill-source")
  .description("Backfill missing source frontmatter on live wiki pages")
  .option("--plan", "dry-run report (default)")
  .option("--apply", "write inferred source fields")
  .option("--force", "reprocess pages that already have a non-unknown source")
  .action(async (opts: { plan?: boolean; apply?: boolean; force?: boolean }) => {
    if (opts.plan && opts.apply) {
      console.error("memory backfill-source: choose at most one of --plan or --apply");
      process.exit(2);
    }
    try {
      const result = await runBackfillSource({
        mode: opts.apply ? "apply" : "plan",
        force: opts.force,
      });
      process.stdout.write(result.report);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("stats")
  .description("Summarize memory state — file counts, install status, git state")
  .action(async () => {
    try {
      const result = await runStats();
      process.stdout.write(formatStatsResult(result));
    } catch (err) {
      console.error(`memory stats failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("Structural health check; exits non-zero if any check fails")
  .action(async () => {
    try {
      const result = await runDoctor();
      process.stdout.write(`${formatDoctorResult(result)}\n`);
      process.exit(result.failed > 0 ? 1 : 0);
    } catch (err) {
      console.error(`memory doctor failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("verify")
  .description("End-to-end health check for vault, sync, dashboard, search, and client capture")
  .option("--offline", "skip network checks such as git remote and dashboard")
  .option("--role <role>", "operator | server")
  .option("--dashboard-url <url>", "dashboard base URL for remote health checks")
  .option("--remote-name <name>", "vault git remote name for sync health checks")
  .option("--json", "emit structured VerifyReport JSON")
  .option("--schedule <action>", "install | uninstall | status")
  .option("--daily <HH:MM>", "daily local time for scheduled verify (default: 09:00)")
  .option("--shell <shell>", "scheduler shell override: powershell | systemd")
  .action(async (opts: {
    offline?: boolean;
    role?: string;
    dashboardUrl?: string;
    remoteName?: string;
    json?: boolean;
    schedule?: VerifyScheduleAction;
    daily?: string;
    shell?: VerifyScheduleShell;
  }) => {
    try {
      if (opts.schedule) {
        const schedule = await runVerifySchedule({
          action: opts.schedule,
          daily: opts.daily,
          shell: opts.shell,
        });
        process.stdout.write(formatVerifyScheduleResult(schedule));
        process.exit(schedule.exitCode);
      }
      let role;
      try {
        role = parseVerifyRole(opts.role);
      } catch (err) {
        console.error(`memory verify failed: ${(err as Error).message}`);
        process.exit(2);
      }
      const result = await runVerify({
        offline: opts.offline,
        role,
        dashboardUrl: opts.dashboardUrl,
        remoteName: opts.remoteName,
      });
      process.stdout.write(
        opts.json
          ? `${JSON.stringify(result, null, 2)}\n`
          : formatVerifyResult(result),
      );
      process.exit(result.exitCode);
    } catch (err) {
      console.error(`memory verify failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("watch")
  .description("Run live capture watchers for supported local clients")
  .option("--clients <list>", "comma-separated clients to watch")
  .action(async (opts: { clients?: string }) => {
    const shutdown = new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    try {
      const result = await runWatch({
        clients: opts.clients,
        shutdown,
        onStatus: (line) => process.stderr.write(`${line}\n`),
      });
      process.stderr.write(formatWatchResult(result));
    } catch (err) {
      console.error(`memory watch failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("tail-errors")
  .description("Live tail of ~/.memory/errors.log (Ctrl+C to exit)")
  .action(async () => {
    try {
      await runTailErrors();
    } catch (err) {
      console.error(`memory tail-errors failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("search <query>")
  .description("Search memory via the dashboard /api/search endpoint")
  .option("--scope <scope>", "wiki | raw | crystals | all (default: all)")
  .option("--k <n>", "top-K results (default: 10)", (v) => parseInt(v, 10))
  .option("--min-score <n>", "minimum score filter (0..1)", parseFloat)
  .option("--no-rerank", "skip Voyage rerank (faster, less accurate)")
  .option("--json", "emit raw JSON instead of pretty-printed results")
  .option("--dashboard-url <url>", "override dashboard base URL (e.g., https://other.example/memory)")
  .option("--vps-url <url>", "legacy alias for --dashboard-url")
  .action(async (
    query: string,
    opts: {
      scope?: "wiki" | "raw" | "crystals" | "all";
      k?: number;
      minScore?: number;
      rerank?: boolean;
      json?: boolean;
      dashboardUrl?: string;
      vpsUrl?: string;
    },
  ) => {
    const result = await runSearch(query, {
      scope: opts.scope,
      k: opts.k,
      minScore: opts.minScore,
      noRerank: opts.rerank === false,
      json: opts.json,
      dashboardUrl: opts.dashboardUrl,
      vpsUrl: opts.vpsUrl,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  });

function registerStub(name: string, phase: number, description: string): void {
  program
    .command(name)
    .description(
      `${description} (Phase ${phase} - not yet implemented in Phase 1)`,
    )
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      console.error(
        `memory ${name}: not yet implemented in Phase 1. ` +
          `Slated for Phase ${phase}. See plan: ` +
          `docs/superpowers/plans/2026-05-20-phase-1-foundation-plan.md`,
      );
      process.exit(2);
    });
}

if (process.env.MEMORY_FORT_SHOW_STUBS === "1") {
  registerStub(
    "crystallize",
    4,
    "Distill a completed thread into a long-form digest",
  );
  registerStub("backup", 6, "git commit + push memory state to remote");
  registerStub(
    "import-from-agentmemory",
    5,
    "Deprecated alias; use import-agentmemory",
  );
  registerStub(
    "retain",
    6,
    "Run retention policy: archive expired raws, prune embeddings",
  );
  registerStub(
    "schedule",
    6,
    "Install OS-level scheduled tasks (Windows Task Scheduler / cron)",
  );
}

printDebugLogBanner();
await program.parseAsync(process.argv);

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}

function parseFloatOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}
