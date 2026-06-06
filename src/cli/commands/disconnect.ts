import { CLIENTS, type ClientName } from "./client-status.js";
import { runUninstall, type RunUninstallOptions } from "./uninstall.js";

export interface DisconnectOptions extends RunUninstallOptions {
  all?: boolean;
  client?: ClientName;
}

export interface DisconnectClientResult {
  client: ClientName;
  ok: boolean;
  detail: string;
}

export interface DisconnectResult {
  clients: DisconnectClientResult[];
  exitCode: number;
}

export async function runDisconnect(
  opts: DisconnectOptions = {},
): Promise<DisconnectResult> {
  const targets = opts.client ? [opts.client] : CLIENTS;
  const clients: DisconnectClientResult[] = [];
  let antigravityResult: DisconnectClientResult | null = null;

  for (const client of targets) {
    if (client === "antigravity-ide" && antigravityResult) {
      clients.push({
        client,
        ok: antigravityResult.ok,
        detail: antigravityResult.ok
          ? "disconnected (shared workspace/IDE config)"
          : antigravityResult.detail,
      });
      continue;
    }

    const platform = client === "antigravity-ide" ? "antigravity" : client;
    const result = await runUninstall(platform, opts);
    const clientResult = {
      client,
      ok: result.exitCode === 0,
      detail: result.actions.join("; ") || "nothing to remove",
    };
    clients.push(clientResult);
    if (client === "antigravity") antigravityResult = clientResult;
  }

  return {
    clients,
    exitCode: clients.every((client) => client.ok) ? 0 : 1,
  };
}

export function formatDisconnectResult(result: DisconnectResult): string {
  return `${result.clients
    .map((client) => `${client.ok ? "ok" : "fail"} ${client.client.padEnd(18)} ${client.detail}`)
    .join("\n")}\n`;
}
