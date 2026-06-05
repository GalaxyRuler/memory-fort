import type { Command } from "commander";
import { runInstallTailscaleRoute } from "./install-tailscale-route.js";
import { runInstallVps } from "./install-vps.js";
import { runPull, formatPullSuccess } from "./pull.js";
import { runPush, formatPushSuccess } from "./push.js";
import { runSync, formatSyncSuccess } from "./sync.js";
import { runSyncBootstrap } from "./sync-bootstrap.js";

export function registerPrivateOps(program: Command): void {
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
    .description("Configure ~/.memory/ to use the hosted bare repo as a git remote and install the post-receive hook")
    .option("--remote-name <name>", "remote name (default: vps; use whitedragon for the Whitedragon mirror)")
    .option("--ssh-host <host>", "host name (default: from config or srv1317946)")
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
    .description("Pull-rebase then push to the configured vault remote; surfaces conflicts loudly")
    .option("--remote-name <name>", "remote name (default: vps)")
    .option("--branch <name>", "branch (default: main)")
    .action(async (opts: { remoteName?: string; branch?: string }) => {
      try {
        const result = await runSync({ remoteName: opts.remoteName, branch: opts.branch });
        process.stderr.write(formatSyncSuccess(result));
      } catch (err) {
        handleSyncCliError("sync", err);
      }
    });

  program
    .command("pull")
    .description("git pull --rebase from the configured vault remote")
    .option("--remote-name <name>", "remote name (default: vps)")
    .option("--branch <name>", "branch (default: main)")
    .action(async (opts: { remoteName?: string; branch?: string }) => {
      try {
        const result = await runPull({ remoteName: opts.remoteName, branch: opts.branch });
        process.stderr.write(formatPullSuccess(result));
      } catch (err) {
        handleSyncCliError("pull", err);
      }
    });

  program
    .command("push")
    .description("git push to the configured vault remote with retry on push-reject")
    .option("--remote-name <name>", "remote name (default: vps)")
    .option("--branch <name>", "branch (default: main)")
    .action(async (opts: { remoteName?: string; branch?: string }) => {
      try {
        const result = await runPush({ remoteName: opts.remoteName, branch: opts.branch });
        process.stderr.write(formatPushSuccess(result));
      } catch (err) {
        handleSyncCliError("push", err);
      }
    });
}

function handleSyncCliError(command: string, err: unknown): never {
  const exitCode = typeof (err as { exitCode?: unknown }).exitCode === "number"
    ? (err as { exitCode: number }).exitCode
    : 1;
  console.error(`memory ${command} failed: ${(err as Error).message}`);
  process.exit(exitCode);
}
