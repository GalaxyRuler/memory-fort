#!/usr/bin/env node
import { Command } from "commander";
import { runGrep, type GrepScope } from "./cli/commands/grep.js";
import { runInit } from "./cli/commands/init.js";
import { runInstall } from "./cli/commands/install.js";

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

program.parseAsync(process.argv);
