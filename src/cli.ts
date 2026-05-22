#!/usr/bin/env node
import { Command } from "commander";
import { runCompile } from "./cli/commands/compile.js";
import { runDoctor, formatDoctorResult } from "./cli/commands/doctor.js";
import { runGrep, type GrepScope } from "./cli/commands/grep.js";
import { runInit } from "./cli/commands/init.js";
import { runInstall } from "./cli/commands/install.js";
import { runInstallTailscaleRoute } from "./cli/commands/install-tailscale-route.js";
import { runInstallVps } from "./cli/commands/install-vps.js";
import { runLint } from "./cli/commands/lint.js";
import { runLog } from "./cli/commands/log.js";
import { runPage } from "./cli/commands/page.js";
import { runPull, formatPullSuccess } from "./cli/commands/pull.js";
import { runPush, formatPushSuccess } from "./cli/commands/push.js";
import { runStats, formatStatsResult } from "./cli/commands/stats.js";
import { runSync, formatSyncSuccess } from "./cli/commands/sync.js";
import { runSyncBootstrap } from "./cli/commands/sync-bootstrap.js";
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
  .command("install-vps")
  .description("Lay out /root/memory-system/ on the VPS via SSH (idempotent)")
  .option("--ssh-host <host>", "VPS hostname over Tailscale (default: srv1317946)")
  .option("--install-root <path>", "install root on the VPS (default: /root/memory-system)")
  .option("--dry-run", "print SSH commands without executing")
  .action(async (opts: { sshHost?: string; installRoot?: string; dryRun?: boolean }) => {
    try {
      const result = await runInstallVps({
        sshHost: opts.sshHost,
        installRoot: opts.installRoot,
        dryRun: opts.dryRun,
      });
      if (opts.dryRun) {
        return;
      }
      console.error(`VPS install complete at ${result.host}:${result.installRoot}`);
      console.error(`  steps: ${result.steps.length}`);
      console.error(`  services changed: ${result.servicesChanged ? "YES (investigate)" : "no"}`);
      console.error(`  node path:        ${result.systemd.nodePath}`);
      console.error(`  dashboard:        ${result.systemd.dashboardServiceActive ? "active" : "inactive"}`);
      console.error(`  backup timer:     ${result.systemd.backupTimerActive ? "active" : "inactive"}`);
      console.error(`  backup next:      ${result.systemd.backupTimerNext || "(unknown)"}`);
      console.error(`  healthz:          ${result.systemd.healthzOk ? "ok" : "failed"}`);
      if (result.servicesChanged) {
        console.error("WARNING: existing services state differs pre vs post. Inspect pre/post snapshots.");
        process.exit(1);
      }
    } catch (err) {
      console.error(`memory install-vps failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("install-tailscale-route")
  .description("Add /memory/ path route to Tailscale Serve on the VPS (preserves existing routes)")
  .option("--ssh-host <host>", "VPS hostname (default: srv1317946)")
  .option("--dashboard-port <port>", "local dashboard port on VPS (default: 4410)", (v) => parseInt(v, 10))
  .option("--path-prefix <path>", "path prefix on Tailscale Serve (default: /memory)")
  .option("--dry-run", "print the tailscale serve command without executing")
  .action(async (opts: { sshHost?: string; dashboardPort?: number; pathPrefix?: string; dryRun?: boolean }) => {
    try {
      const result = await runInstallTailscaleRoute({
        sshHost: opts.sshHost,
        dashboardPort: opts.dashboardPort,
        pathPrefix: opts.pathPrefix,
        dryRun: opts.dryRun,
      });
      if (opts.dryRun) return;
      console.error("Tailscale route install complete.");
      console.error(`  host:             ${result.host}`);
      console.error(`  route:            ${result.pathPrefix} -> http://127.0.0.1:${result.dashboardPort}`);
      console.error(`  already configured: ${result.alreadyConfigured ? "yes" : "no"}`);
      console.error(`  reachability VPS:   ${result.reachabilityVps ? "ok" : "failed"}`);
      console.error(`  reachability local: ${result.reachabilityLocal ? "ok" : "failed"}`);
      console.error(`  serve command:      ${result.serveCommand}`);
    } catch (err) {
      console.error(`memory install-tailscale-route failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("sync-bootstrap")
  .description("Configure ~/.memory/ to use the VPS bare repo as remote `vps` and install the post-receive hook")
  .option("--remote-name <name>", "remote name (default: vps)")
  .option("--ssh-host <host>", "VPS hostname (default: from config or srv1317946)")
  .option("--vps-install-root <path>", "VPS install root (default: /root/memory-system)")
  .option("--branch <name>", "branch to push (default: main)")
  .option("--skip-initial-push", "configure remote but don't push existing commits")
  .action(async (opts) => {
    try {
      const result = await runSyncBootstrap({
        remoteName: opts.remoteName,
        sshHost: opts.sshHost,
        vpsInstallRoot: opts.vpsInstallRoot,
        branch: opts.branch,
        skipInitialPush: opts.skipInitialPush,
      });
      console.error("Sync bootstrap complete.");
      console.error(`  remote:           ${result.remoteName} -> ${result.remoteUrl}`);
      console.error(`  remote created:   ${result.remoteCreated ? "yes (new)" : `no (was ${result.previousRemoteUrl})`}`);
      console.error(`  post-receive:     ${result.postReceiveInstalled ? "installed" : "skipped"}`);
      console.error(`  initial push:     ${result.initialPushPerformed ? "performed" : "skipped (remote already has commits)"}`);
    } catch (err) {
      console.error(`memory sync-bootstrap failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("sync")
  .description("Pull-rebase then push to the VPS remote; surfaces conflicts loudly")
  .option("--remote-name <name>", "remote name (default: vps)")
  .option("--branch <name>", "branch (default: main)")
  .action(async (opts: { remoteName?: string; branch?: string }) => {
    try {
      const result = await runSync({ remoteName: opts.remoteName, branch: opts.branch });
      process.stderr.write(formatSyncSuccess(result, opts.remoteName ?? "vps", opts.branch ?? "main"));
    } catch (err) {
      handleSyncCliError("sync", err);
    }
  });

program
  .command("pull")
  .description("git pull --rebase from VPS remote")
  .option("--remote-name <name>", "remote name (default: vps)")
  .option("--branch <name>", "branch (default: main)")
  .action(async (opts: { remoteName?: string; branch?: string }) => {
    try {
      const result = await runPull({ remoteName: opts.remoteName, branch: opts.branch });
      process.stderr.write(formatPullSuccess(result, opts.remoteName ?? "vps", opts.branch ?? "main"));
    } catch (err) {
      handleSyncCliError("pull", err);
    }
  });

program
  .command("push")
  .description("git push to VPS remote with retry on push-reject")
  .option("--remote-name <name>", "remote name (default: vps)")
  .option("--branch <name>", "branch (default: main)")
  .action(async (opts: { remoteName?: string; branch?: string }) => {
    try {
      const result = await runPush({ remoteName: opts.remoteName, branch: opts.branch });
      process.stderr.write(formatPushSuccess(result, opts.remoteName ?? "vps", opts.branch ?? "main"));
    } catch (err) {
      handleSyncCliError("push", err);
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
        if (opts.output) {
          console.error(`Compile prompt written to ${opts.output}`);
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

function handleSyncCliError(command: string, err: unknown): never {
  const exitCode = typeof (err as { exitCode?: unknown }).exitCode === "number"
    ? (err as { exitCode: number }).exitCode
    : 1;
  console.error(`memory ${command} failed: ${(err as Error).message}`);
  process.exit(exitCode);
}
