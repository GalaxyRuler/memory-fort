import { installAntigravity } from "./install/antigravity.js";
import { installClaudeCode } from "./install/claude-code.js";
import { runInstallClaudeDesktop } from "./install/claude-desktop.js";
import { installCodex } from "./install/codex.js";
import { installVsCode } from "./install/vscode.js";
import { CLIENTS, type ClientName } from "./client-status.js";

export interface ConnectOptions {
  all?: boolean;
  client?: ClientName;
  workspace?: string;
  vscodeInstalled?: boolean;
}

export interface ConnectClientResult {
  client: ClientName;
  ok: boolean;
  detail: string;
}

export interface ConnectResult {
  clients: ConnectClientResult[];
  exitCode: number;
}

export async function runConnect(opts: ConnectOptions = {}): Promise<ConnectResult> {
  const targets = opts.client ? [opts.client] : CLIENTS;
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
  return { clients, exitCode };
}

export function formatConnectResult(result: ConnectResult): string {
  return result.clients
    .map((client) => `${client.ok ? "✓" : "✗"} ${client.client.padEnd(18)} ${client.detail}`)
    .join("\n") + "\n";
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
