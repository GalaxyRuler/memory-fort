import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, normalize, relative, resolve, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  claudeDesktopConfigDir,
  claudeDesktopConfigPath,
  formatIsoDate,
  memoryRoot,
} from "../../../storage/paths.js";
import {
  isClaudeCodePluginEnabled,
} from "../install/claude-code.js";
import { vscodeExtensionDir, vscodeMcpConfigPath } from "../install/vscode.js";
import { fail, pass, warn, type CheckDescriptor, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

/** Enabled, historically active clients are treated as an outage after this many silent days. */
export const CAPTURE_STALE_FAIL_DAYS = 3;

export const claudeCodeEnabledCheck: CheckDescriptor = {
  id: "client.claude-code.enabled",
  label: "Claude Code plugin enabled",
  roles: ["operator"],
  run: () => checkClaudeCodeEnabled(),
};

export const claudeCodeHookPathsCheck: CheckDescriptor = {
  id: "client.claude-code.hooks",
  label: "Claude Code hook command paths resolve",
  roles: ["operator"],
  run: () => checkClaudeCodeHookPaths(),
};

export const claudeCodeCaptureCheck: CheckDescriptor = {
  id: "client.claude-code.capture",
  label: "Claude Code capture is fresh",
  roles: ["operator"],
  run: (ctx) => checkRecentCapture(ctx, ["claude-code-", "claude-"], "client.claude-code.capture", "claude-code", {
    staleFailWhen: () => isClaudeCodePluginEnabled(),
    staleFailureSuggestedFix: "restart Claude Code and run one tool; then rerun `memory verify`",
  }),
};

export const snifferClaudeCodeBackfillCheck: CheckDescriptor = {
  id: "sniffer.claude-code.backfill",
  label: "Claude Code backfill store available",
  roles: ["operator"],
  run: () => checkClaudeCodeBackfillStore(),
};

export const codexConfigCheck: CheckDescriptor = {
  id: "client.codex.config",
  label: "Codex MCP block present",
  roles: ["operator"],
  run: () => checkCodexConfig(),
};

export const codexCaptureCheck: CheckDescriptor = {
  id: "client.codex.capture",
  label: "Codex capture is fresh",
  roles: ["operator"],
  run: (ctx) => checkRecentCapture(ctx, ["codex-"], "client.codex.capture", "codex", {
    staleFailWhen: () => isCodexConfigured(),
    staleFailureSuggestedFix: "restart Codex and run one tool; then rerun `memory verify`",
  }),
};

export const antigravityConfigCheck: CheckDescriptor = {
  id: "client.antigravity.config",
  label: "Antigravity MCP entry present",
  roles: ["operator"],
  run: () => checkJsonServer(
    antigravityConfigPath(),
    "mcpServers",
    "client.antigravity.config",
    "antigravity MCP entry present (informational)",
    "run `memory connect antigravity`",
    true,
  ),
};

export const snifferAntigravityPluginCheck: CheckDescriptor = {
  id: "sniffer.antigravity.plugin",
  label: "Antigravity live-capture plugin installed",
  roles: ["operator"],
  run: () => checkAntigravityPlugin(),
};

export const antigravityCaptureCheck: CheckDescriptor = {
  id: "client.antigravity.capture",
  label: "Antigravity captures present",
  roles: ["operator"],
  run: (ctx) => checkAnyCapture(ctx, ["antigravity-"], "client.antigravity.capture"),
};

export const vscodeConfigCheck: CheckDescriptor = {
  id: "client.vscode.config",
  label: "VS Code MCP entry present",
  roles: ["operator"],
  run: () => checkJsonServer(
    vscodeMcpConfigPath(),
    "servers",
    "client.vscode.config",
    "vscode MCP entry present",
    "run `memory connect vscode`",
  ),
};

export const snifferVscodeExtensionCheck: CheckDescriptor = {
  id: "sniffer.vscode.extension",
  label: "VS Code Memory Fort extension installed",
  roles: ["operator"],
  run: () => checkVsCodeExtension(),
};

export const snifferVscodeCaptureCheck: CheckDescriptor = {
  id: "sniffer.vscode.capture",
  label: "VS Code extension capture is fresh",
  roles: ["operator"],
  run: (ctx) => checkVsCodeCapture(ctx),
};

export const claudeDesktopConfigCheck: CheckDescriptor = {
  id: "client.claude-desktop.config",
  label: "Claude Desktop MCP entry present",
  roles: ["operator"],
  run: () => checkJsonServer(
    claudeDesktopConfigPath(),
    "mcpServers",
    "client.claude-desktop.config",
    "claude-desktop MCP entry present",
    "run `memory connect claude-desktop`",
  ),
};

export const snifferClaudeDesktopWatcherCheck: CheckDescriptor = {
  id: "sniffer.claude-desktop.watcher",
  label: "Claude Desktop watcher source available",
  roles: ["operator"],
  run: () => checkClaudeDesktopWatcher(),
};

export const snifferClaudeDesktopCaptureCheck: CheckDescriptor = {
  id: "sniffer.claude-desktop.capture",
  label: "Claude Desktop watcher capture is fresh",
  roles: ["operator"],
  run: (ctx) => checkRecentCapture(ctx, ["claude-desktop-"], "sniffer.claude-desktop.capture", "claude-desktop watcher"),
};

export const CLIENT_CHECKS: CheckDescriptor[] = [
  claudeCodeEnabledCheck,
  claudeCodeHookPathsCheck,
  claudeCodeCaptureCheck,
  snifferClaudeCodeBackfillCheck,
  codexConfigCheck,
  codexCaptureCheck,
  antigravityConfigCheck,
  snifferAntigravityPluginCheck,
  antigravityCaptureCheck,
  vscodeConfigCheck,
  snifferVscodeExtensionCheck,
  snifferVscodeCaptureCheck,
  claudeDesktopConfigCheck,
  snifferClaudeDesktopWatcherCheck,
  snifferClaudeDesktopCaptureCheck,
];

export async function checkClients(
  ctx: VerifyCheckContext,
): Promise<VerifyCheckResult[]> {
  return (await Promise.all(CLIENT_CHECKS.map((check) => check.run(ctx)))).flat();
}

async function checkClaudeCodeEnabled(): Promise<VerifyCheckResult> {
  const enabled = await isClaudeCodePluginEnabled();
  return enabled
    ? pass("client.claude-code.enabled", "claude-code plugin enabled")
    : fail(
        "client.claude-code.enabled",
        "claude-code plugin enabled",
        "run `memory connect claude-code`",
      );
}

async function checkCodexConfig(): Promise<VerifyCheckResult> {
  const ok = await isCodexConfigured();
  return ok
    ? pass("client.codex.config", "codex MCP block present")
    : fail(
        "client.codex.config",
        "codex MCP block present",
        "run `memory connect codex`",
      );
}

async function isCodexConfigured(): Promise<boolean> {
  const configPath = join(
    process.env["MEMORY_CODEX_DIR"] ?? join(homedir(), ".codex"),
    "config.toml",
  );
  if (!existsSync(configPath)) return false;
  const raw = await readFile(configPath, "utf-8");
  return raw.includes("[mcp_servers.memory]") && raw.includes("mcp-server.mjs");
}

async function checkClaudeCodeHookPaths(): Promise<VerifyCheckResult> {
  const pluginRoots = await resolveClaudeCodePluginRoots();
  if (pluginRoots.length === 0) {
    return fail(
      "client.claude-code.hooks",
      "Claude Code hook command paths resolve",
      "run `npm run build` and `memory connect claude-code`",
      "missing Claude Code memory plugin root",
    );
  }

  for (const pluginRoot of pluginRoots) {
    const result = await validateClaudeCodePluginHooks(pluginRoot);
    if (result.status !== "pass") return result;
  }

  return pass(
    "client.claude-code.hooks",
    "Claude Code hook command paths resolve",
    `validated ${pluginRoots.length} plugin root${pluginRoots.length === 1 ? "" : "s"}`,
  );
}

async function resolveClaudeCodePluginRoots(): Promise<string[]> {
  const installed = await readInstalledClaudeCodePluginRoots();
  if (installed.length > 0) return installed;

  const sourceRoot = join(memoryRoot(), "claude-code-plugin");
  return existsSync(sourceRoot) ? [sourceRoot] : [];
}

async function readInstalledClaudeCodePluginRoots(): Promise<string[]> {
  const installedPath = join(
    process.env["MEMORY_CLAUDE_DIR"] ?? join(homedir(), ".claude"),
    "plugins",
    "installed_plugins.json",
  );
  if (!existsSync(installedPath)) return [];

  try {
    const parsed = JSON.parse(await readFile(installedPath, "utf-8")) as Record<string, unknown>;
    const plugins = parsed["plugins"];
    if (typeof plugins !== "object" || plugins === null) return [];
    const entries = (plugins as Record<string, unknown>)["memory@memory-local"];
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => {
        if (typeof entry !== "object" || entry === null) return null;
        const installPath = (entry as Record<string, unknown>)["installPath"];
        return typeof installPath === "string" && existsSync(installPath)
          ? installPath
          : null;
      })
      .filter((entry): entry is string => entry !== null);
  } catch {
    return [];
  }
}

async function validateClaudeCodePluginHooks(pluginRoot: string): Promise<VerifyCheckResult> {
  const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    return fail(
      "client.claude-code.hooks",
      "Claude Code hook command paths resolve",
      "run `npm run build` and `memory connect claude-code`",
      `missing plugin manifest at ${manifestPath}`,
    );
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return fail(
      "client.claude-code.hooks",
      "Claude Code hook command paths resolve",
      "run `memory connect claude-code`",
      `plugin manifest JSON is malformed at ${manifestPath}`,
    );
  }

  if (manifest["hooksPath"] !== undefined || manifest["mcpConfig"] !== undefined) {
    return fail(
      "client.claude-code.hooks",
      "Claude Code hook command paths resolve",
      "run `memory connect claude-code`",
      "plugin manifest uses legacy hooksPath/mcpConfig fields; expected hooks/mcpServers",
    );
  }

  const hooksRel = typeof manifest["hooks"] === "string"
    ? manifest["hooks"] as string
    : "./hooks/hooks.json";
  const hooksPath = resolvePluginPath(pluginRoot, hooksRel);
  if (!isInsideRoot(pluginRoot, hooksPath)) {
    return fail(
      "client.claude-code.hooks",
      "Claude Code hook command paths resolve",
      "run `memory connect claude-code`",
      `hooks path escapes plugin root: ${hooksRel}`,
    );
  }
  if (!existsSync(hooksPath)) {
    return fail(
      "client.claude-code.hooks",
      "Claude Code hook command paths resolve",
      "run `memory connect claude-code`",
      `missing hooks file at ${hooksPath}`,
    );
  }

  let hooksConfig: Record<string, unknown>;
  try {
    hooksConfig = JSON.parse(await readFile(hooksPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return fail(
      "client.claude-code.hooks",
      "Claude Code hook command paths resolve",
      "run `memory connect claude-code`",
      `hooks JSON is malformed at ${hooksPath}`,
    );
  }

  const scriptRefs = extractClaudeCodeHookScriptRefs(hooksConfig);
  if (scriptRefs.length === 0) {
    return fail(
      "client.claude-code.hooks",
      "Claude Code hook command paths resolve",
      "run `memory connect claude-code`",
      "no Claude Code command hook script paths found",
    );
  }

  for (const scriptRef of scriptRefs) {
    const resolvedScript = resolveClaudePluginRootPath(pluginRoot, scriptRef);
    if (!isInsideRoot(pluginRoot, resolvedScript)) {
      return fail(
        "client.claude-code.hooks",
        "Claude Code hook command paths resolve",
        "run `memory connect claude-code`",
        `hook script escapes plugin root: ${scriptRef}`,
      );
    }
    if (!existsSync(resolvedScript)) {
      return fail(
        "client.claude-code.hooks",
        "Claude Code hook command paths resolve",
        "run `memory connect claude-code`",
        `missing script ${scriptRef} resolved to ${resolvedScript}`,
      );
    }
    const launcherTargetFailure = await validateHookLauncherTarget(resolvedScript);
    if (launcherTargetFailure) {
      return fail(
        "client.claude-code.hooks",
        "Claude Code hook command paths resolve",
        "run `npm run build` and `memory connect claude-code`",
        launcherTargetFailure,
      );
    }
  }

  return pass(
    "client.claude-code.hooks",
    "Claude Code hook command paths resolve",
    `validated ${scriptRefs.length} hook script path${scriptRefs.length === 1 ? "" : "s"} under ${pluginRoot}`,
  );
}

function extractClaudeCodeHookScriptRefs(hooksConfig: Record<string, unknown>): string[] {
  const hookMap = hooksConfig["hooks"];
  if (typeof hookMap !== "object" || hookMap === null) return [];

  const refs: string[] = [];
  for (const eventEntries of Object.values(hookMap as Record<string, unknown>)) {
    if (!Array.isArray(eventEntries)) continue;
    for (const eventEntry of eventEntries) {
      if (typeof eventEntry !== "object" || eventEntry === null) continue;
      const hooks = (eventEntry as Record<string, unknown>)["hooks"];
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        if (typeof hook !== "object" || hook === null) continue;
        const scriptRef = extractCommandHookScriptRef(hook as Record<string, unknown>);
        if (scriptRef) refs.push(scriptRef);
      }
    }
  }
  return refs;
}

function extractCommandHookScriptRef(hook: Record<string, unknown>): string | null {
  if (hook["type"] !== "command") return null;
  const command = hook["command"];
  const args = hook["args"];
  if (typeof command === "string" && command === "node" && Array.isArray(args)) {
    const firstArg = args.find((arg) => typeof arg === "string");
    return typeof firstArg === "string" ? firstArg : null;
  }
  if (typeof command !== "string") return null;

  const match = command.match(/\bnode(?:\.exe)?\s+("([^"]+)"|'([^']+)'|(\S+))/i);
  return match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
}

function resolveClaudePluginRootPath(pluginRoot: string, value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const pluginRootVar = "${CLAUDE_PLUGIN_ROOT}";
  if (normalized === pluginRootVar) return resolve(pluginRoot);
  if (normalized.startsWith(`${pluginRootVar}/`)) {
    return resolve(pluginRoot, normalized.slice(pluginRootVar.length + 1));
  }
  return resolvePluginPath(pluginRoot, value);
}

async function validateHookLauncherTarget(scriptPath: string): Promise<string | null> {
  const targetPath = await readHookLauncherTarget(scriptPath);
  if (!targetPath) return null;
  return existsSync(targetPath)
    ? null
    : `hook launcher target missing: ${targetPath}`;
}

async function readHookLauncherTarget(scriptPath: string): Promise<string | null> {
  const raw = await readFile(scriptPath, "utf-8");
  const match = raw.match(/\bmemoryHookTarget\s*=\s*("[^"]+"|'[^']+')/);
  if (!match) return null;

  try {
    const encodedTarget = JSON.parse(match[1]) as unknown;
    if (typeof encodedTarget !== "string") return null;
    return encodedTarget.startsWith("file:")
      ? fileURLToPath(encodedTarget)
      : resolve(dirname(scriptPath), encodedTarget);
  } catch {
    return null;
  }
}

function resolvePluginPath(pluginRoot: string, value: string): string {
  return isAbsolute(value) ? normalize(value) : resolve(pluginRoot, value);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function checkJsonServer(
  configPath: string,
  serverKey: "mcpServers" | "servers",
  id: string,
  label: string,
  fix: string,
  informational = false,
): Promise<VerifyCheckResult> {
  const ok = await jsonHasMemoryServer(configPath, serverKey);
  if (ok) return pass(id, label);
  return informational
    ? warn(id, label, `missing at ${configPath}`, fix)
    : fail(id, label, fix, `missing at ${configPath}`);
}

async function jsonHasMemoryServer(
  configPath: string,
  serverKey: "mcpServers" | "servers",
): Promise<boolean> {
  if (!existsSync(configPath)) return false;
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const servers = parsed[serverKey];
    if (typeof servers !== "object" || servers === null) return false;
    const memory = (servers as Record<string, unknown>)["memory"];
    return typeof memory === "object" && memory !== null;
  } catch {
    return false;
  }
}

async function checkRecentCapture(
  ctx: VerifyCheckContext,
  prefixes: string[],
  id: string,
  label: string,
  opts: {
    staleFailWhen?: () => Promise<boolean>;
    staleFailureSuggestedFix?: string;
  } = {},
): Promise<VerifyCheckResult> {
  const snapshot = await readCaptureSnapshot(ctx, prefixes);
  if (snapshot.recentCount > 0) {
    return pass(id, `${label} captures today`, `${snapshot.recentCount} captures today`);
  }

  if (snapshot.lastSeen) {
    const ageDays = Math.floor((ctx.now().getTime() - snapshot.lastSeen.getTime()) / DAY_MS);
    const shouldFail = opts.staleFailWhen ? await opts.staleFailWhen() : false;
    if (shouldFail && ageDays >= CAPTURE_STALE_FAIL_DAYS) {
      return fail(
        id,
        `${label} captures today`,
        opts.staleFailureSuggestedFix,
        `OUTAGE: enabled but no capture in ${ageDays} days (last seen ${formatIsoDate(snapshot.lastSeen)})`,
      );
    }
    return warn(
      id,
      `${label} captures today`,
      `idle (no capture 24h, last seen ${formatIsoDate(snapshot.lastSeen)})`,
    );
  }

  return warn(
    id,
    `${label} captures today`,
    "no capture file from the last 24h",
  );
}

async function checkAnyCapture(
  ctx: VerifyCheckContext,
  prefixes: string[],
  id: string,
): Promise<VerifyCheckResult> {
  const snapshot = await readCaptureSnapshot(ctx, prefixes);
  return snapshot.historicalCount > 0
    ? pass(id, "antigravity live hooks captured", `${snapshot.historicalCount} captures`)
    : warn(
        id,
        "antigravity live hooks have not captured yet",
        "no antigravity captures found",
      );
}

async function checkClaudeCodeBackfillStore(): Promise<VerifyCheckResult> {
  const projectsDir =
    process.env["MEMORY_CLAUDE_PROJECTS_DIR"] ?? join(homedir(), ".claude", "projects");
  return existsSync(projectsDir)
    ? pass("sniffer.claude-code.backfill", "claude-code backfill store available")
    : warn(
        "sniffer.claude-code.backfill",
        "claude-code backfill store available",
        `missing at ${projectsDir}`,
      );
}

async function checkAntigravityPlugin(): Promise<VerifyCheckResult> {
  const pluginDir = join(antigravityDir(), "plugins", "memory");
  const manifestPath = join(pluginDir, "plugin.json");
  const hooksPath = join(pluginDir, "hooks.json");
  if (!existsSync(manifestPath) || !existsSync(hooksPath)) {
    return warn(
      "sniffer.antigravity.plugin",
      "antigravity live-capture plugin installed",
      `missing plugin files at ${pluginDir}`,
      "run `memory connect antigravity`",
    );
  }

  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
    const hooks = JSON.parse(await readFile(hooksPath, "utf-8")) as Record<string, unknown>;
    const hookMap = hooks["hooks"];
    const hasManifest = manifest["name"] === "memory" && manifest["hooks"] === "./hooks.json";
    const hasHooks = typeof hookMap === "object" && hookMap !== null;
    const missingHook = ANTIGRAVITY_HOOK_NAMES.find(
      (hook) => !(hasHooks && hook in (hookMap as Record<string, unknown>)) ||
        !existsSync(join(pluginDir, "hooks", `${hook}.mjs`)),
    );
    return hasManifest && !missingHook
      ? pass("sniffer.antigravity.plugin", "antigravity live-capture plugin installed")
      : warn(
          "sniffer.antigravity.plugin",
          "antigravity live-capture plugin installed",
          missingHook ? `missing hook ${missingHook}` : "plugin manifest invalid",
          "run `memory connect antigravity`",
        );
  } catch {
    return warn(
      "sniffer.antigravity.plugin",
      "antigravity live-capture plugin installed",
      "plugin JSON is malformed",
      "run `memory connect antigravity`",
    );
  }
}

async function checkClaudeDesktopWatcher(): Promise<VerifyCheckResult> {
  const dir = claudeDesktopConfigDir();
  return existsSync(dir)
    ? pass("sniffer.claude-desktop.watcher", "claude-desktop watcher source available")
    : warn(
        "sniffer.claude-desktop.watcher",
        "claude-desktop watcher source available",
        `missing at ${dir}`,
        "run Claude Desktop once, then `memory watch --clients claude-desktop`",
      );
}

async function checkVsCodeExtension(): Promise<VerifyCheckResult> {
  const extensionPath = join(vscodeExtensionDir(), "memory-fort.memory", "package.json");
  if (!existsSync(extensionPath)) {
    return warn(
      "sniffer.vscode.extension",
      "vscode Memory Fort extension installed",
      `missing at ${extensionPath}`,
      "run `memory connect vscode`",
    );
  }
  try {
    const parsed = JSON.parse(await readFile(extensionPath, "utf-8")) as Record<string, unknown>;
    const contributes = parsed["contributes"] as Record<string, unknown> | undefined;
    const participants = contributes?.["chatParticipants"];
    const ok = Array.isArray(participants) &&
      participants.some((entry) => {
        const participant = entry as Record<string, unknown>;
        return participant["id"] === "memory-fort.memory";
      });
    return ok
      ? pass("sniffer.vscode.extension", "vscode Memory Fort extension installed")
      : warn(
          "sniffer.vscode.extension",
          "vscode Memory Fort extension installed",
          "chat participant missing",
          "run `memory connect vscode`",
        );
  } catch {
    return warn(
      "sniffer.vscode.extension",
      "vscode Memory Fort extension installed",
      "extension package JSON is malformed",
      "run `memory connect vscode`",
    );
  }
}

async function checkVsCodeCapture(ctx: VerifyCheckContext): Promise<VerifyCheckResult> {
  const snapshot = await readCaptureSnapshot(ctx, ["vscode-"]);
  if (snapshot.recentCount > 0) {
    return pass("sniffer.vscode.capture", "vscode extension captures today", `${snapshot.recentCount} captures today`);
  }

  const active = await isVsCodeProcessActive(ctx.runningProcessNames ?? readRunningProcessNames);
  if (active === false) {
    return pass(
      "sniffer.vscode.capture",
      "vscode extension idle",
      "VS Code is not running; capture is expected when VS Code starts",
    );
  }

  return checkRecentCapture(ctx, ["vscode-"], "sniffer.vscode.capture", "vscode extension");
}

async function isVsCodeProcessActive(readProcessNames: () => Promise<string[]>): Promise<boolean | null> {
  try {
    const names = await readProcessNames();
    return names.some(isVsCodeProcessName);
  } catch {
    return null;
  }
}

async function readRunningProcessNames(): Promise<string[]> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true });
    return stdout.split(/\r?\n/).map(readTasklistImageName).filter(Boolean);
  }

  const { stdout } = await execFileAsync("ps", ["-A", "-o", "comm="], { windowsHide: true });
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function readTasklistImageName(line: string): string {
  const match = /^"((?:[^"]|"")*)"/.exec(line.trim());
  return (match?.[1]?.replace(/""/g, "\"") ?? line.split(",")[0] ?? "").trim();
}

function isVsCodeProcessName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/\.exe$/, "");
  return normalized === "code" ||
    normalized === "code - insiders" ||
    normalized === "code helper" ||
    normalized === "vscodium" ||
    normalized === "codium";
}

async function readCaptureSnapshot(
  ctx: VerifyCheckContext,
  prefixes: string[],
): Promise<{ recentCount: number; historicalCount: number; lastSeen: Date | null }> {
  const rawRoot = join(ctx.vaultRoot, "raw");
  const dirs = await listDirectoryNames(rawRoot);
  let recentCount = 0;
  let historicalCount = 0;
  let lastSeen: Date | null = null;
  for (const dir of dirs) {
    const fullDir = join(rawRoot, dir);
    let entries: string[];
    try {
      entries = await readdir(fullDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      if (!prefixes.some((prefix) => entry.startsWith(prefix))) continue;
      const info = await stat(join(fullDir, entry));
      historicalCount += 1;
      if (!lastSeen || info.mtime.getTime() > lastSeen.getTime()) lastSeen = info.mtime;
      if (ctx.now().getTime() - info.mtime.getTime() <= DAY_MS) recentCount += 1;
    }
  }
  return { recentCount, historicalCount, lastSeen };
}

async function listDirectoryNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function antigravityConfigPath(): string {
  return join(antigravityDir(), "mcp_config.json");
}

function antigravityDir(): string {
  return process.env["MEMORY_ANTIGRAVITY_DIR"] ??
    join(homedir(), ".gemini", "antigravity");
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
