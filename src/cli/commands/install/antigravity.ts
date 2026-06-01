import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { memoryRoot, logPath } from "../../../storage/paths.js";
import { atomicWrite, atomicAppend } from "../../../storage/atomic-write.js";

export interface InstallAntigravityOptions {
  /** Override ~/.gemini/antigravity/ (default). */
  antigravityDir?: string;
  /** Antigravity Editor and workspace currently share the same MCP config. */
  surface?: "workspace" | "ide" | "both";
  /** For tests, or callers that already probed `antigravity --version`. */
  antigravityVersion?: string | null;
  /** For tests. */
  now?: Date;
}

export interface InstallAntigravityResult {
  mcpConfigPath: string;
  configCreated: boolean;
  hadPriorMemoryEntry: boolean;
  surfaces: Array<"workspace" | "ide">;
  pluginDir: string;
  livePluginInstalled: boolean;
  log: string[];
}

const ANTIGRAVITY_HOOK_NAMES = [
  "session_start",
  "pre_turn",
  "post_turn",
  "pre_tool_call",
  "post_tool_call",
  "tool_error_recovery",
  "user_interaction_handling",
  "context_compaction",
  "session_end",
] as const;

function mcpServerAbs(): string {
  return join(memoryRoot(), "claude-code-plugin", "scripts", "mcp-server.mjs").replace(
    /\\/g,
    "/",
  );
}

export async function installAntigravity(
  opts: InstallAntigravityOptions = {},
): Promise<InstallAntigravityResult> {
  const antigravityDir =
    opts.antigravityDir ??
    process.env["MEMORY_ANTIGRAVITY_DIR"] ??
    join(homedir(), ".gemini", "antigravity");
  const configPath = join(antigravityDir, "mcp_config.json");
  const pluginDir = join(antigravityDir, "plugins", "memory");

  const log: string[] = [];

  let existing: Record<string, unknown> = {};
  let configCreated = false;
  if (existsSync(configPath)) {
    const raw = await readFile(configPath, "utf-8");
    if (raw.trim().length > 0) {
      try {
        existing = JSON.parse(raw) as Record<string, unknown>;
        if (typeof existing !== "object" || existing === null) {
          existing = {};
        }
      } catch {
        existing = {};
      }
    } else {
      configCreated = true;
    }
  } else {
    configCreated = true;
  }

  let hadPriorMemoryEntry = false;
  const existingServers = existing["mcpServers"];
  if (
    typeof existingServers === "object" &&
    existingServers !== null &&
    "memory" in (existingServers as Record<string, unknown>)
  ) {
    hadPriorMemoryEntry = true;
  }

  const newServers: Record<string, unknown> =
    typeof existingServers === "object" && existingServers !== null
      ? { ...(existingServers as Record<string, unknown>) }
      : {};

  newServers["memory"] = {
    command: "node",
    args: [mcpServerAbs()],
  };

  const newConfig = { ...existing, mcpServers: newServers };
  await atomicWrite(configPath, JSON.stringify(newConfig, null, 2) + "\n");

  log.push(
    configCreated
      ? `created ${configPath} with memory MCP entry`
      : hadPriorMemoryEntry
        ? `updated memory MCP entry in ${configPath}`
        : `merged memory MCP entry into existing ${configPath}`,
  );

  const version =
    opts.antigravityVersion === undefined
      ? detectAntigravityVersion()
      : opts.antigravityVersion;
  const livePluginInstalled = supportsAntigravityLivePlugin(version);
  if (livePluginInstalled) {
    await installAntigravityLivePlugin(pluginDir);
    log.push(
      version
        ? `installed Antigravity live-capture plugin at ${pluginDir}`
        : `version not detected; installed Antigravity live-capture plugin at ${pluginDir}`,
    );
  } else {
    log.push(
      "Antigravity 2.0 required for live capture; you can still backfill via export",
    );
  }

  const now = opts.now ?? new Date();
  const surfaces =
    opts.surface === "workspace"
      ? (["workspace"] as const)
      : opts.surface === "ide"
        ? (["ide"] as const)
        : (["workspace", "ide"] as const);
  await atomicAppend(
    logPath(),
    `## [${now.toISOString()}] install | antigravity ${surfaces.join("+")}: MCP entry in ${configPath}\n`,
  );

  return {
    mcpConfigPath: configPath,
    configCreated,
    hadPriorMemoryEntry,
    surfaces: [...surfaces],
    pluginDir,
    livePluginInstalled,
    log,
  };
}

function detectAntigravityVersion(): string | null {
  try {
    return execFileSync("antigravity", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function supportsAntigravityLivePlugin(version: string | null | undefined): boolean {
  if (!version) return true;
  const match = version.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 2 || (major === 2 && minor >= 0);
}

async function installAntigravityLivePlugin(pluginDir: string): Promise<void> {
  const hooksConfig = {
    hooks: Object.fromEntries(
      ANTIGRAVITY_HOOK_NAMES.map((name) => [
        name,
        [
          {
            type: "command",
            command: `node ./hooks/${name}.mjs`,
          },
        ],
      ]),
    ),
  };
  const manifest = {
    name: "memory",
    version: "0.1.0",
    description: "Memory Fort live capture hooks for Antigravity 2.0",
    hooks: "./hooks.json",
  };

  await atomicWrite(join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  await atomicWrite(
    join(pluginDir, "hooks.json"),
    JSON.stringify(hooksConfig, null, 2) + "\n",
  );

  for (const hookName of ANTIGRAVITY_HOOK_NAMES) {
    await atomicWrite(
      join(pluginDir, "hooks", `${hookName}.mjs`),
      renderAntigravityHookScript(hookName),
    );
  }
}

function renderAntigravityHookScript(hookName: string): string {
  const sectionTitleByHook: Record<string, string> = {
    session_start: "Session Start",
    pre_turn: "Prompt",
    post_turn: "Response",
    pre_tool_call: "ToolUse",
    post_tool_call: "ToolResult",
    tool_error_recovery: "Tool Error Recovery",
    user_interaction_handling: "User Interaction",
    context_compaction: "Context Compaction",
    session_end: "Session End",
  };
  const title = sectionTitleByHook[hookName] ?? hookName;

  return `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const hookName = ${JSON.stringify(hookName)};
const sectionTitle = ${JSON.stringify(title)};
const input = readStdinJson();
const now = new Date(stringField(input, "timestamp") || stringField(input, "time") || Date.now());
const memoryRoot = process.env.MEMORY_ROOT || join(homedir(), ".memory");
const sessionId = safeName(
  stringField(input, "sessionId") ||
  stringField(input, "session_id") ||
  stringField(input, "conversationId") ||
  "unknown"
);
const date = isoDate(now);
const file = join(memoryRoot, "raw", date, \`antigravity-\${sessionId}.md\`);

ensureStarted(file, input, now);
appendSection(file, sectionTitle, sectionBody(input));

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf-8").trim();
    return raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function ensureStarted(filePath, payload, dateValue) {
  if (existsSync(filePath)) return;
  mkdirSync(dirname(filePath), { recursive: true });
  const cwd = stringField(payload, "cwd") || stringField(payload, "workspace") || "";
  const session = stringField(payload, "sessionId") || stringField(payload, "session_id") || "unknown";
  const frontmatter = [
    "---",
    "source: antigravity",
    \`session_id: \${session.replace(/"/g, "")}\`,
    \`created: \${isoDate(dateValue)}\`,
    \`updated: \${isoDate(dateValue)}\`,
    cwd ? \`cwd: \${JSON.stringify(cwd)}\` : null,
    "---",
    "",
    \`# Antigravity Session \${session}\`,
    "",
  ].filter(Boolean).join("\\n");
  writeFileSync(filePath, frontmatter, "utf-8");
}

function appendSection(filePath, heading, body) {
  mkdirSync(dirname(filePath), { recursive: true });
  const time = now.toISOString().slice(11, 19);
  appendFileSync(filePath, \`\\n## [\${time}] \${heading}\\n\\n\${body.trim() || "(no payload)"}\\n\`, "utf-8");
}

function sectionBody(payload) {
  if (hookName === "pre_turn") return stringField(payload, "prompt") || stringField(payload, "input") || stringify(payload);
  if (hookName === "post_turn") return stringField(payload, "response") || stringField(payload, "output") || stringify(payload);
  if (hookName === "pre_tool_call" || hookName === "post_tool_call") {
    const tool = stringField(payload, "toolName") || stringField(payload, "tool_name") || stringField(payload, "name") || "tool";
    return \`### \${tool}\\n\\n\${stringify(payload)}\`;
  }
  if (hookName === "tool_error_recovery") return stringField(payload, "error") || stringify(payload);
  if (hookName === "context_compaction") return stringField(payload, "summary") || stringify(payload);
  return stringify(payload);
}

function stringField(value, key) {
  if (!value || typeof value !== "object") return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function stringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_");
}

function isoDate(dateValue) {
  return dateValue.toISOString().slice(0, 10);
}
`;
}
