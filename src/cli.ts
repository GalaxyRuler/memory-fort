#!/usr/bin/env node
import { Command } from "commander";
import { runCompile } from "./cli/commands/compile.js";
import { runDoctor, formatDoctorResult } from "./cli/commands/doctor.js";
import { runGrep, type GrepScope } from "./cli/commands/grep.js";
import { runInit } from "./cli/commands/init.js";
import { runInstall } from "./cli/commands/install.js";
import { runLint } from "./cli/commands/lint.js";
import { runLog } from "./cli/commands/log.js";
import { runStats, formatStatsResult } from "./cli/commands/stats.js";
import { runTailErrors } from "./cli/commands/tail-errors.js";

const program = new Command();

program
  .name("memory")
  .description("Cross-tool memory system CLI")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize ~/.memory/ with schema, index, log, config, and git")
  .option(
    "--reset",
    "destructive — archives existing ~/.memory/ before re-init",
  )
  .action(async (opts: { reset?: boolean }) => {
    try {
      const result = await runInit({ reset: opts.reset });
      console.log(`Initialized memory at ${result.root}`);
      console.log(`  created:    ${result.created.length} paths`);
      console.log(`  preserved:  ${result.preserved.length} paths`);
      if (result.archivedTo) {
        console.log(`  archived to: ${result.archivedTo}`);
      }
    } catch (err) {
      console.error(`memory init failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("install <platform>")
  .description("Install hooks + MCP for a platform (claude-code, codex, antigravity)")
  .action(async (platform: string) => {
    try {
      await runInstall(platform);
    } catch (err) {
      console.error(`memory install ${platform} failed: ${(err as Error).message}`);
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
  .command("compile")
  .description("Assemble an LLM prompt from raw observations and wiki context")
  .option("--since <iso>", "ISO date/timestamp cutoff for raw files")
  .option("--per-file-max-bytes <n>", "max raw bytes per file", parseInteger)
  .option("--total-max-bytes <n>", "max total raw bytes", parseInteger)
  .option("-o, --output <path>", "also write the assembled prompt to a file")
  .action(
    async (opts: {
      since?: string;
      perFileMaxBytes?: number;
      totalMaxBytes?: number;
      output?: string;
    }) => {
      try {
        const result = await runCompile({
          since: opts.since,
          perFileMaxBytes: opts.perFileMaxBytes,
          totalMaxBytes: opts.totalMaxBytes,
          outputPath: opts.output,
        });
        process.stdout.write(result.prompt);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    },
  );

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

registerStub(
  "search",
  3,
  "Hybrid retrieval (BM25 + voyage-4-large + rerank + graph)",
);
registerStub(
  "crystallize",
  4,
  "Distill a completed thread into a long-form digest",
);
registerStub("backup", 6, "git commit + push memory state to remote");
registerStub("page", 2, "Pretty-print a wiki page with resolved relations");
registerStub(
  "import-from-agentmemory",
  5,
  "One-shot migration from GalaxyRuler/agentmemory",
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

program.parseAsync(process.argv);

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid integer: ${value}`);
  }
  return parsed;
}
