import { CLIENTS, type ClientName } from "./client-status.js";
import {
  removeSharedPluginScripts,
  runUninstall,
  type RunUninstallOptions,
} from "./uninstall.js";

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
  /** Present when shared launchers were cleaned up after a full disconnect. */
  sharedRuntimeCleanup?: string[];
}

export async function runDisconnect(
  opts: DisconnectOptions = {},
): Promise<DisconnectResult> {
  const targets = opts.client ? [opts.client] : CLIENTS;
  const disconnectingAll = opts.client === undefined || opts.all === true;
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

  let sharedRuntimeCleanup: string[] | undefined;
  // Full client list / --all: no remaining installer still points at scripts/.
  if (disconnectingAll && targets.length >= CLIENTS.length) {
    sharedRuntimeCleanup = await removeSharedPluginScripts(opts);
  }

  return {
    clients,
    exitCode: clients.every((client) => client.ok) ? 0 : 1,
    ...(sharedRuntimeCleanup && sharedRuntimeCleanup.length > 0
      ? { sharedRuntimeCleanup }
      : {}),
  };
}

export function formatDisconnectResult(result: DisconnectResult): string {
  const lines = result.clients.map(
    (client) => `${client.ok ? "ok" : "fail"} ${client.client.padEnd(18)} ${client.detail}`,
  );
  if (result.sharedRuntimeCleanup && result.sharedRuntimeCleanup.length > 0) {
    lines.push(`ok shared-runtime   ${result.sharedRuntimeCleanup.join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}
