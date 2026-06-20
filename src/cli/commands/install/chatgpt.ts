import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

import yaml from "js-yaml";
import { atomicWrite } from "../../../storage/atomic-write.js";
import { memoryRoot } from "../../../storage/paths.js";
import { loadMemoryConfig, getChatGptBridgePort } from "../../../storage/config.js";
import { generateBridgeTlsCert, loadBridgeTlsCert, trustBridgeCert } from "../../../mcp/tls.js";
import { runChatGptBridgeStart, runChatGptBridgeStatus } from "../chatgpt-bridge.js";

const execFileAsync = promisify(execFile);

const AUTOSTART_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const AUTOSTART_NAME = "MemoryFortChatGptBridge";

export interface InstallChatGptOptions {
  port?: number;
  noAutostart?: boolean;
  dryRun?: boolean;
}

export interface InstallChatGptResult {
  port: number;
  bridgeUrl: string;
  alreadyRunning: boolean;
  autostartRegistered: boolean;
  instructions: string;
}

export async function runInstallChatGpt(
  opts: InstallChatGptOptions = {},
): Promise<InstallChatGptResult> {
  const root = memoryRoot();
  const config = await loadMemoryConfig(root);
  const port = opts.port ?? getChatGptBridgePort(config);

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid bridge port ${port}: must be integer between 1024 and 65535`);
  }

  const bridgeUrl = `https://localhost:${port}/sse`;

  if (!opts.dryRun) {
    // Write port to config.yaml directly (chatgpt section is not in applyConfigPatch safelist)
    const configPath = join(root, "config.yaml");
    const updated = {
      ...config,
      clients: { ...config.clients, chatgpt: true },
      chatgpt: { ...config.chatgpt, bridge_port: port },
    };
    await atomicWrite(
      configPath,
      yaml.dump(updated, { schema: yaml.JSON_SCHEMA, lineWidth: 100, noRefs: true, sortKeys: false }),
    );
  }

  if (!opts.dryRun) {
    const existingCert = await loadBridgeTlsCert();
    if (!existingCert) {
      await generateBridgeTlsCert();
    }
    const trustResult = await trustBridgeCert();
    if (!trustResult.trusted) {
      console.warn(`TLS trust: ${trustResult.message}`);
    }
  }

  let autostartRegistered = false;
  if (!opts.noAutostart && !opts.dryRun && process.platform === "win32") {
    try {
      const autoStartCmd = `"${process.execPath}" "${process.argv[1]}" chatgpt-bridge start`;
      await execFileAsync("reg.exe", [
        "add", AUTOSTART_KEY, "/v", AUTOSTART_NAME, "/t", "REG_SZ", "/d", autoStartCmd, "/f",
      ]);
      autostartRegistered = true;
    } catch {
      // Best-effort; don't fail install
    }
  }

  const status = await runChatGptBridgeStatus();
  const alreadyRunning = status.running;

  if (!opts.dryRun && !alreadyRunning) {
    await runChatGptBridgeStart();
  }

  const instructions = buildInstructions(port, bridgeUrl);
  return { port, bridgeUrl, alreadyRunning, autostartRegistered, instructions };
}

export function printInstallChatGptResult(result: InstallChatGptResult): void {
  console.log(result.instructions);
}

function buildInstructions(port: number, bridgeUrl: string): string {
  void port; // used indirectly via bridgeUrl
  return [
    "",
    `✓ Memory bridge running at ${bridgeUrl}`,
    "",
    "Connect in ChatGPT desktop:",
    "  Settings → Connectors → Advanced → enable Developer Mode",
    `  Add connector URL: ${bridgeUrl}`,
    "",
    "Recommended Custom Instructions for ChatGPT:",
    '  "At the end of each conversation, call log_observation',
    '   with key insights, decisions, and facts worth remembering."',
    "",
    "Run 'memory verify' to confirm setup.",
    "",
  ].join("\n");
}
