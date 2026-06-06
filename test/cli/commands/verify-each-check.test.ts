import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkAutoPush } from "../../../src/cli/commands/verify/autopush.js";
import { checkClients } from "../../../src/cli/commands/verify/clients.js";
import { checkCompile } from "../../../src/cli/commands/verify/compile.js";
import { checkDashboard, resolveDashboardUrl } from "../../../src/cli/commands/verify/dashboard.js";
import { checkGitRemote } from "../../../src/cli/commands/verify/git.js";
import { checkEpisodicRelations } from "../../../src/cli/commands/verify/episodic-relations.js";
import { checkSearch } from "../../../src/cli/commands/verify/search.js";
import { checkVaultReadWrite } from "../../../src/cli/commands/verify/vault.js";

describe("verify checks", () => {
  let tmp: string;
  let origEnv: Record<string, string | undefined>;
  const now = () => new Date("2026-05-26T03:30:00.000Z");

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "verify-check-"));
    origEnv = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      MEMORY_CLAUDE_DIR: process.env["MEMORY_CLAUDE_DIR"],
      MEMORY_CLAUDE_PROJECTS_DIR: process.env["MEMORY_CLAUDE_PROJECTS_DIR"],
      MEMORY_CODEX_DIR: process.env["MEMORY_CODEX_DIR"],
      MEMORY_ANTIGRAVITY_DIR: process.env["MEMORY_ANTIGRAVITY_DIR"],
      MEMORY_OPENCODE_DIR: process.env["MEMORY_OPENCODE_DIR"],
      MEMORY_OPENCOVEN_COMMAND: process.env["MEMORY_OPENCOVEN_COMMAND"],
      MEMORY_VSCODE_USER_DIR: process.env["MEMORY_VSCODE_USER_DIR"],
      MEMORY_VSCODE_EXTENSION_DIR: process.env["MEMORY_VSCODE_EXTENSION_DIR"],
      MEMORY_CLAUDE_DESKTOP_DIR: process.env["MEMORY_CLAUDE_DESKTOP_DIR"],
    };
    process.env["MEMORY_ROOT"] = tmp;
    process.env["MEMORY_CLAUDE_DIR"] = join(tmp, ".claude");
    process.env["MEMORY_CLAUDE_PROJECTS_DIR"] = join(tmp, ".claude", "projects");
    process.env["MEMORY_CODEX_DIR"] = join(tmp, ".codex");
    process.env["MEMORY_ANTIGRAVITY_DIR"] = join(tmp, ".gemini", "antigravity");
    process.env["MEMORY_OPENCODE_DIR"] = join(tmp, ".config", "opencode");
    process.env["MEMORY_OPENCOVEN_COMMAND"] = join(tmp, "missing-coven");
    process.env["MEMORY_VSCODE_USER_DIR"] = join(tmp, "Code", "User");
    process.env["MEMORY_CLAUDE_DESKTOP_DIR"] = join(tmp, "Claude");
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(origEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("vault read/write creates, reads, and deletes its temp file", async () => {
    const result = await checkVaultReadWrite({ vaultRoot: tmp, now });

    expect(result.status).toBe("pass");
    expect(existsSync(join(tmp, "raw", ".verify-1779766200000.tmp"))).toBe(false);
  });

  it("git remote check warns instead of executing in offline mode", async () => {
    let called = false;
    const result = await checkGitRemote({
      vaultRoot: tmp,
      offline: true,
      execFile: async () => {
        called = true;
      },
    });

    expect(result.status).toBe("warn");
    expect(result.label).toContain("skipped");
    expect(called).toBe(false);
  });

  it("git remote check uses the configured sync remote name", async () => {
    let seenArgs: string[] = [];
    const result = await checkGitRemote({
      vaultRoot: tmp,
      configLoader: async () => ({ sync: { remote_name: "mirror" } }),
      execFile: async (_file, args) => {
        seenArgs = args;
      },
    });

    expect(result.status).toBe("pass");
    expect(result.label).toContain("mirror");
    expect(seenArgs).toEqual(["ls-remote", "mirror"]);
  });

  it("dashboard URL resolves from dashboard.url before legacy vps host", async () => {
    await expect(
      resolveDashboardUrl(undefined, async () => ({
        dashboard: { url: "https://mirror.example/memory/" },
        vps: { host: "old-vps.example" },
      })),
    ).resolves.toBe("https://mirror.example/memory");
  });

  it("dashboard check fails when /api/status does not return JSON", async () => {
    const result = await checkDashboard({
      dashboardUrl: "https://example.test/memory",
      fetchFn: async () =>
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    });

    expect(result.status).toBe("fail");
    expect(result.suggestedFix).toContain("dashboard");
  });

  it("search check passes when the pipeline returns at least one result", async () => {
    const result = await checkSearch({
      vaultRoot: tmp,
      searchFn: async () => ({
        query: "memory fort",
        results: [{ path: "wiki/projects/memory-fort.md" }],
        timings: { totalMs: 47 },
      }),
    });

    expect(result.status).toBe("pass");
    expect(result.label).toContain("returned 1 results in 47ms");
  });

  it("episodic relation coverage warns below thirty percent", async () => {
    await writeRawObservation("raw/2026-05-26/linked.md", ["wiki/projects/memory-fort.md"]);
    await writeRawObservation("raw/2026-05-26/orphan-a.md", []);
    await writeRawObservation("raw/2026-05-26/orphan-b.md", []);
    await writeRawObservation("raw/2026-05-26/orphan-c.md", []);

    const result = await checkEpisodicRelations({ vaultRoot: tmp, now });

    expect(result.status).toBe("warn");
    expect(result.label).toContain("25% of episodic memories have >=1 relation");
    expect(result.detail).toContain("3 orphaned");
    expect(result.suggestedFix).toContain("memory consolidate --plan");
  });

  it("episodic relation coverage passes at thirty percent or above", async () => {
    await writeRawObservation("raw/2026-05-26/linked-a.md", ["wiki/projects/memory-fort.md"]);
    await writeRawObservation("raw/2026-05-26/linked-b.md", ["wiki/tools/codex.md"]);
    await writeRawObservation("raw/2026-05-26/orphan-a.md", []);
    await writeRawObservation("raw/2026-05-26/orphan-b.md", []);

    const result = await checkEpisodicRelations({ vaultRoot: tmp, now });

    expect(result.status).toBe("pass");
    expect(result.label).toContain("50% of episodic memories have >=1 relation");
  });

  it("client checks catch enabled Claude Code with no recent capture as a warning", async () => {
    await mkdir(process.env["MEMORY_CLAUDE_DIR"]!, { recursive: true });
    await writeFile(
      join(process.env["MEMORY_CLAUDE_DIR"]!, "settings.json"),
      JSON.stringify({ enabledPlugins: { "memory@memory-local": true } }),
    );

    const results = await checkClients({ vaultRoot: tmp, now });

    expect(
      results.find((result) => result.id === "client.claude-code.enabled")?.status,
    ).toBe("pass");
    expect(
      results.find((result) => result.id === "client.claude-code.capture")?.status,
    ).toBe("warn");
  });

  it("client checks fail when enabled Claude Code hook command paths do not resolve under the plugin root", async () => {
    await installBrokenClaudeCodePlugin("missing-script.mjs");

    const results = await checkClients({ vaultRoot: tmp, now });

    const hookPaths = results.find((result) => result.id === "client.claude-code.hooks");
    expect(hookPaths?.status).toBe("fail");
    expect(hookPaths?.detail).toContain("missing script");
    expect(hookPaths?.detail).toContain("missing-script.mjs");
  });

  it("client checks fail when a Claude Code hook launcher points at a missing built hook", async () => {
    await installBrokenClaudeCodePlugin("session-start.mjs");
    const missingBuiltHook = join(tmp, "dist", "hooks", "session-start.mjs");
    await writeFile(
      join(tmp, "claude-code-plugin", "scripts", "session-start.mjs"),
      [
        "// Generated by memory install claude-code.",
        `export const memoryHookTarget = ${JSON.stringify(pathToFileURL(missingBuiltHook).href)};`,
        "await import(memoryHookTarget);",
        "",
      ].join("\n"),
    );

    const results = await checkClients({ vaultRoot: tmp, now });

    const hookPaths = results.find((result) => result.id === "client.claude-code.hooks");
    expect(hookPaths?.status).toBe("fail");
    expect(hookPaths?.detail).toContain("hook launcher target missing");
    expect(hookPaths?.detail).toContain("dist");
  });

  it("client checks fail when enabled Claude Code was previously capturing but is silent for the stale threshold", async () => {
    await enableClaudeCode();
    await writeCapture(
      "raw/2026-05-22/claude-code-old.md",
      "claude old",
      "2026-05-22T03:00:00.000Z",
    );

    const results = await checkClients({ vaultRoot: tmp, now });

    const capture = results.find((result) => result.id === "client.claude-code.capture");
    expect(capture?.status).toBe("fail");
    expect(capture?.detail).toContain("OUTAGE: enabled but no capture in 4 days");
    expect(capture?.detail).toContain("last seen 2026-05-22");
  });

  it("client checks warn, not fail, for enabled Claude Code that has never captured", async () => {
    await enableClaudeCode();

    const results = await checkClients({ vaultRoot: tmp, now });

    const capture = results.find((result) => result.id === "client.claude-code.capture");
    expect(capture?.status).toBe("warn");
    expect(capture?.detail).toBe("no capture file from the last 24h");
  });

  it("client checks warn, not fail, for enabled Claude Code idle longer than 24h but below the outage threshold", async () => {
    await enableClaudeCode();
    await writeCapture(
      "raw/2026-05-25/claude-code-yesterday.md",
      "claude yesterday",
      "2026-05-25T01:00:00.000Z",
    );

    const results = await checkClients({ vaultRoot: tmp, now });

    const capture = results.find((result) => result.id === "client.claude-code.capture");
    expect(capture?.status).toBe("warn");
    expect(capture?.detail).toContain("idle (no capture 24h, last seen 2026-05-25)");
  });

  it("client checks do not warn for VS Code capture when VS Code is inactive", async () => {
    await mkdir(process.env["MEMORY_VSCODE_USER_DIR"]!, { recursive: true });
    await mkdir(join(tmp, ".vscode", "extensions", "memory-fort.memory"), { recursive: true });
    await writeFile(
      join(process.env["MEMORY_VSCODE_USER_DIR"]!, "mcp.json"),
      JSON.stringify({ servers: { memory: { command: "node" } } }),
    );
    process.env["MEMORY_VSCODE_EXTENSION_DIR"] = join(tmp, ".vscode", "extensions");
    await writeFile(
      join(tmp, ".vscode", "extensions", "memory-fort.memory", "package.json"),
      JSON.stringify({ contributes: { chatParticipants: [{ id: "memory-fort.memory" }] } }),
    );

    const results = await checkClients({
      vaultRoot: tmp,
      now,
      runningProcessNames: async () => [],
    });

    const capture = results.find((result) => result.id === "sniffer.vscode.capture");
    expect(capture?.status).toBe("pass");
    expect(capture?.detail).toContain("VS Code is not running");
  });

  it("client checks describe missing Antigravity captures as live-hook pending", async () => {
    const results = await checkClients({ vaultRoot: tmp, now });
    const capture = results.find((result) => result.id === "client.antigravity.capture");

    expect(capture?.status).toBe("warn");
    expect(capture?.label).toBe("antigravity live hooks have not captured yet");
    expect(capture?.detail).toBe("no antigravity captures found");
  });

  it("client checks warn when OpenCoven is not ready", async () => {
    const results = await checkClients({ vaultRoot: tmp, now });

    const readiness = results.find((result) => result.id === "client.opencoven.readiness");
    expect(readiness?.status).toBe("warn");
    expect(readiness?.label).toBe("OpenCoven readiness");
    expect(readiness?.detail).toContain("coven CLI not found");
    expect(readiness?.suggestedFix).toContain("npx @opencoven/cli doctor");
  });

  it("client checks pass when the OpenCode MCP config is wired", async () => {
    await writeOpenCodeConfig();

    const results = await checkClients({ vaultRoot: tmp, now });

    const config = results.find((result) => result.id === "client.opencode.config");
    expect(config?.status).toBe("pass");
    expect(config?.label).toBe("OpenCode MCP entry present");
  });

  it("client checks pass when the OpenCode plugin is installed", async () => {
    await writeOpenCodePlugin();

    const results = await checkClients({ vaultRoot: tmp, now });

    const plugin = results.find((result) => result.id === "client.opencode.plugin");
    expect(plugin?.status).toBe("pass");
    expect(plugin?.label).toBe("OpenCode Memory Fort plugin installed");
  });

  it("client checks pass when OpenCode has a recent capture", async () => {
    await writeCapture(
      "raw/2026-05-26/opencode-live.md",
      "opencode live",
      "2026-05-26T03:00:00.000Z",
    );

    const results = await checkClients({ vaultRoot: tmp, now });

    const capture = results.find((result) => result.id === "client.opencode.capture");
    expect(capture?.status).toBe("pass");
    expect(capture?.detail).toBe("1 captures today");
  });

  it("client checks report sniffer, plugin, watcher, and extension health", async () => {
    await mkdir(join(process.env["MEMORY_CLAUDE_DIR"]!, "projects"), { recursive: true });
    await mkdir(join(process.env["MEMORY_ANTIGRAVITY_DIR"]!, "plugins", "memory", "hooks"), { recursive: true });
    await mkdir(process.env["MEMORY_VSCODE_USER_DIR"]!, { recursive: true });
    await mkdir(join(tmp, ".vscode", "extensions", "memory-fort.memory"), { recursive: true });
    await mkdir(process.env["MEMORY_CLAUDE_DESKTOP_DIR"]!, { recursive: true });
    await mkdir(join(tmp, "raw", "2026-05-26"), { recursive: true });

    await writeFile(
      join(process.env["MEMORY_ANTIGRAVITY_DIR"]!, "plugins", "memory", "plugin.json"),
      JSON.stringify({ name: "memory", hooks: "./hooks.json" }),
    );
    await writeFile(
      join(process.env["MEMORY_ANTIGRAVITY_DIR"]!, "plugins", "memory", "hooks.json"),
      JSON.stringify({
        hooks: Object.fromEntries([
          "session_start",
          "pre_turn",
          "post_turn",
          "pre_tool_call",
          "post_tool_call",
          "tool_error_recovery",
          "user_interaction_handling",
          "context_compaction",
          "session_end",
        ].map((hook) => [hook, [{ command: `node ./hooks/${hook}.mjs` }]])),
      }),
    );
    for (const hook of [
      "session_start",
      "pre_turn",
      "post_turn",
      "pre_tool_call",
      "post_tool_call",
      "tool_error_recovery",
      "user_interaction_handling",
      "context_compaction",
      "session_end",
    ]) {
      await writeFile(
        join(process.env["MEMORY_ANTIGRAVITY_DIR"]!, "plugins", "memory", "hooks", `${hook}.mjs`),
        "",
      );
    }
    await writeFile(
      join(process.env["MEMORY_VSCODE_USER_DIR"]!, "mcp.json"),
      JSON.stringify({ servers: { memory: { command: "node" } } }),
    );
    process.env["MEMORY_VSCODE_EXTENSION_DIR"] = join(tmp, ".vscode", "extensions");
    await writeFile(
      join(tmp, ".vscode", "extensions", "memory-fort.memory", "package.json"),
      JSON.stringify({ contributes: { chatParticipants: [{ id: "memory-fort.memory" }] } }),
    );
    await writeFile(
      join(tmp, "raw", "2026-05-26", "claude-desktop-live.md"),
      "desktop",
    );
    await writeFile(join(tmp, "raw", "2026-05-26", "vscode-live.md"), "vscode");

    const results = await checkClients({ vaultRoot: tmp, now });

    expect(results.find((result) => result.id === "sniffer.claude-code.backfill")?.status).toBe("pass");
    expect(results.find((result) => result.id === "sniffer.antigravity.plugin")?.status).toBe("pass");
    expect(results.find((result) => result.id === "sniffer.claude-desktop.watcher")?.status).toBe("pass");
    expect(results.find((result) => result.id === "sniffer.claude-desktop.capture")?.status).toBe("pass");
    expect(results.find((result) => result.id === "sniffer.vscode.extension")?.status).toBe("pass");
    expect(results.find((result) => result.id === "sniffer.vscode.capture")?.status).toBe("pass");
  });

  it("auto-push check fails for errors in the last hour and warns for the last day", async () => {
    await writeFile(
      join(tmp, "errors.log"),
      [
        "[2026-05-26T03:00:00.000Z] auto-push schedule failed: ENOENT",
        "[2026-05-25T12:00:00.000Z] auto-push schedule failed: ENOENT",
      ].join("\n"),
    );

    const result = await checkAutoPush({ vaultRoot: tmp, now });

    expect(result.status).toBe("fail");
    expect(result.label).toContain("1 errors in last hour");
  });

  it("auto-push check ignores pending-lock contention entries", async () => {
    await writeFile(join(tmp, ".auto-push-pending.lock"), "pending");
    await writeFile(
      join(tmp, "errors.log"),
      "[2026-05-26T03:00:00.000Z] auto-push schedule failed: EPERM: operation not permitted, open 'C:\\Users\\Admin\\.memory\\.auto-push-pending.lock'\n",
    );

    const result = await checkAutoPush({ vaultRoot: tmp, now });

    expect(result.status).toBe("pass");
    expect(result.label).toContain("no errors in last 24h");
  });

  it("auto-push check keeps lock errors visible when no pending lock exists", async () => {
    await writeFile(
      join(tmp, "errors.log"),
      "[2026-05-26T03:00:00.000Z] auto-push schedule failed: EPERM: operation not permitted, open 'C:\\Users\\Admin\\.memory\\.auto-push-pending.lock'\n",
    );

    const result = await checkAutoPush({ vaultRoot: tmp, now });

    expect(result.status).toBe("fail");
    expect(result.label).toContain("1 errors in last hour");
  });

  it("auto-push check ignores errors older than the latest successful schedule", async () => {
    await writeFile(join(tmp, ".auto-push-last-scheduled"), "2026-05-26T03:15:00.000Z\n");
    await writeFile(
      join(tmp, "errors.log"),
      [
        "[2026-05-26T03:00:00.000Z] auto-push schedule failed: ENOENT",
        "[2026-05-26T03:20:00.000Z] auto-push schedule failed: ENOENT",
      ].join("\n"),
    );

    const result = await checkAutoPush({ vaultRoot: tmp, now });

    expect(result.status).toBe("fail");
    expect(result.label).toContain("1 errors in last hour");
  });

  it("compile check passes when the dashboard status has a recent compile", async () => {
    const result = await checkCompile({
      vaultRoot: tmp,
      now,
      dashboardStatus: {
        lastCompile: {
          timestamp: "2026-05-22T00:00:00.000Z",
          line: "## [2026-05-22T00:00:00.000Z] compile | ok",
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.label).toContain("compile last ran 2026-05-22");
  });

  async function writeRawObservation(relPath: string, mentions: string[]): Promise<void> {
    const fullPath = join(tmp, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    const relations = mentions.length > 0
      ? ["relations:", "  mentions:", ...mentions.map((mention) => `    - ${mention}`)]
      : ["relations:", "  mentions: []"];
    await writeFile(
      fullPath,
      [
        "---",
        "title: Test observation",
        "kind: raw",
        ...relations,
        "---",
        "",
        "Captured text.",
        "",
      ].join("\n"),
    );
  }

  async function enableClaudeCode(): Promise<void> {
    await mkdir(process.env["MEMORY_CLAUDE_DIR"]!, { recursive: true });
    await writeFile(
      join(process.env["MEMORY_CLAUDE_DIR"]!, "settings.json"),
      JSON.stringify({ enabledPlugins: { "memory@memory-local": true } }),
    );
  }

  async function installBrokenClaudeCodePlugin(scriptName: string): Promise<void> {
    await enableClaudeCode();
    const pluginRoot = join(tmp, "claude-code-plugin");
    await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await mkdir(join(pluginRoot, "scripts"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "memory",
        hooks: "./hooks/hooks.json",
        mcpServers: "./.mcp.json",
      }),
    );
    await writeFile(
      join(pluginRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { memory: { command: "node" } } }),
    );
    await writeFile(
      join(pluginRoot, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node",
                  args: [`${"${CLAUDE_PLUGIN_ROOT}"}/scripts/${scriptName}`],
                },
              ],
            },
          ],
        },
      }),
    );
  }

  async function writeCapture(
    relPath: string,
    content: string,
    mtimeIso: string,
  ): Promise<void> {
    const fullPath = join(tmp, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
    const mtime = new Date(mtimeIso);
    await utimes(fullPath, mtime, mtime);
  }

  async function writeOpenCodeConfig(): Promise<void> {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      join(opencodeDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          memory: {
            type: "local",
            command: ["node", join(tmp, "hooks", "mcp-server.mjs")],
          },
        },
      }),
    );
  }

  async function writeOpenCodePlugin(): Promise<void> {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await mkdir(join(opencodeDir, "plugins"), { recursive: true });
    await writeFile(
      join(opencodeDir, "plugins", "memory-fort.js"),
      "export const MemoryFortOpenCode = async () => import('file:///tmp/opencode-event.mjs');\n",
    );
  }
});
