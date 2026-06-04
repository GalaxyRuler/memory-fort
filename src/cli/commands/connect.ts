import { installAntigravity } from "./install/antigravity.js";
import { installClaudeCode } from "./install/claude-code.js";
import { runInstallClaudeDesktop } from "./install/claude-desktop.js";
import { installCodex } from "./install/codex.js";
import { installVsCode } from "./install/vscode.js";
import { CLIENTS, type ClientName } from "./client-status.js";
import { formatVerifyResult, runVerify, type VerifyResult } from "./verify.js";
import { planInstallWrites } from "./install.js";
import { guardWrites, type CommandStdout, type ConfirmPrompt } from "./write-guard.js";

export interface ConnectOptions {
  all?: boolean;
  client?: ClientName;
  workspace?: string;
  vscodeInstalled?: boolean;
  vscodeExtensionDir?: string;
  noVerify?: boolean;
  verifyFn?: () => Promise<VerifyResult>;
  dryRun?: boolean;
  yes?: boolean;
  stdout?: CommandStdout;
  confirm?: ConfirmPrompt;
}

export interface ConnectClientResult {
  client: ClientName;
  ok: boolean;
  detail: string;
}

export interface ConnectResult {
  clients: ConnectClientResult[];
  verify?: VerifyResult;
  exitCode: number;
  planned?: string[];
  dryRun?: boolean;
  cancelled?: boolean;
}

export async function runConnect(opts: ConnectOptions = {}): Promise<ConnectResult> {
  const targets = opts.client ? [opts.client] : CLIENTS;
  const planned = uniquePaths(
    targets.flatMap((client) => planInstallWrites(
      client === "antigravity-ide" ? "antigravity" : client,
      opts,
    ) ?? []),
  );
  const guard = await guardWrites({
    command: "memory connect",
    planned,
    dryRun: opts.dryRun,
    yes: opts.yes,
    stdout: opts.stdout,
    confirm: opts.confirm,
  });
  if (!guard.shouldWrite) {
    return {
      clients: targets.map((client) => ({
        client,
        ok: !guard.cancelled,
        detail: guard.cancelled ? "cancelled" : "would install",
      })),
      exitCode: guard.cancelled ? 1 : 0,
      planned,
      dryRun: guard.dryRun,
      cancelled: guard.cancelled,
    };
  }

  const clients: ConnectClientResult[] = [];
  let antigravityResult: ConnectClientResult | null = null;

  for (const client of targets) {
    if (client === "antigravity-ide" && antigravityResult) {
      clients.push({
        client,
        ok: antigravityResult.ok,
        detail: antigravityResult.ok
          ? "installed (shared workspace/IDE config)"
          : antigravityResult.detail,
      });
      continue;
    }

    const result = await installClient(client, opts);
    clients.push(result);
    if (client === "antigravity") antigravityResult = result;
  }

  const exitCode = clients.every((client) => !client.ok) ? 1 : 0;
  const verify = exitCode === 0 && !opts.noVerify
    ? await (opts.verifyFn ?? (() => runVerify()))()
    : undefined;
  return { clients, verify, exitCode, planned };
}

export function formatConnectResult(result: ConnectResult): string {
  const installOutput = result.clients
    .map((client) => `${client.ok ? "✓" : "✗"} ${client.client.padEnd(18)} ${client.detail}`)
    .join("\n") + "\n";
  return result.verify
    ? `${installOutput}\n${formatVerifyResult(result.verify)}`
    : installOutput;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

async function installClient(
  client: ClientName,
  opts: ConnectOptions,
): Promise<ConnectClientResult> {
  try {
    switch (client) {
      case "claude-code": {
        const result = await installClaudeCode();
        return { client, ok: true, detail: `installed (${result.pluginDir})` };
      }
      case "claude-desktop": {
        const result = await runInstallClaudeDesktop();
        return { client, ok: true, detail: `installed (${result.configPath})` };
      }
      case "codex": {
        const result = await installCodex();
        return { client, ok: true, detail: `installed (${result.codexConfigPath})` };
      }
      case "antigravity":
      case "antigravity-ide": {
        const result = await installAntigravity({
          surface: client === "antigravity-ide" ? "ide" : "both",
        });
        return {
          client,
          ok: true,
          detail: `installed (shared workspace/IDE config: ${result.mcpConfigPath})`,
        };
      }
      case "vscode": {
        const result = await installVsCode({
          workspace: opts.workspace,
          installed: opts.vscodeInstalled,
          extensionDir: opts.vscodeExtensionDir,
        });
        return result.status === "installed"
          ? {
              client,
              ok: true,
              detail: `installed (${result.scope}: ${result.configPath})`,
            }
          : { client, ok: false, detail: result.reason ?? "not installed" };
      }
    }
  } catch (err) {
    return {
      client,
      ok: false,
      detail: `failed: ${(err as Error).message}`,
    };
  }
}
