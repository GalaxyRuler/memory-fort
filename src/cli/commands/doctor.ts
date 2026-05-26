import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  memoryRoot,
  schemaPath,
  indexPath,
  logPath,
  configPath,
  errorsLogPath,
} from "../../storage/paths.js";
import {
  formatClientStatus,
  getClientStatuses,
  type ClientStatus,
} from "./client-status.js";
import { isClaudeCodePluginEnabled } from "./install/claude-code.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  hint?: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  clients: ClientStatus[];
  passed: number;
  failed: number;
}

const SUBDIRS = [
  "raw",
  "wiki/projects",
  "wiki/people",
  "wiki/decisions",
  "wiki/lessons",
  "wiki/references",
  "wiki/tools",
  "crystals",
  "embeddings",
  ".archive",
];

export async function runDoctor(): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const root = memoryRoot();

  checks.push({
    name: `~/.memory/ exists (${root})`,
    ok: existsSync(root),
    hint: existsSync(root) ? undefined : "Run: memory init",
  });

  for (const sub of SUBDIRS) {
    const path = join(root, sub);
    checks.push({
      name: `subdir ${sub}/`,
      ok: existsSync(path),
      hint: existsSync(path) ? undefined : "Run: memory init",
    });
  }

  for (const [label, path] of [
    ["schema.md", schemaPath()],
    ["index.md", indexPath()],
    ["log.md", logPath()],
    ["config.yaml", configPath()],
  ] as const) {
    checks.push({
      name: label,
      ok: existsSync(path),
      hint: existsSync(path) ? undefined : "Run: memory init",
    });
  }

  if (existsSync(errorsLogPath())) {
    const size = (await stat(errorsLogPath())).size;
    checks.push({
      name: "errors.log size",
      ok: size < 100 * 1024,
      hint:
        size < 100 * 1024
          ? undefined
          : `errors.log is ${(size / 1024).toFixed(1)} KB - investigate`,
    });
  }

  const pluginManifest = join(
    root,
    "claude-code-plugin",
    ".claude-plugin",
    "plugin.json",
  );
  checks.push({
    name: "claude-code plugin manifest",
    ok: existsSync(pluginManifest),
    hint: existsSync(pluginManifest) ? undefined : "Run: memory install claude-code",
  });

  const pluginScripts = join(
    root,
    "claude-code-plugin",
    "scripts",
    "session-start.mjs",
  );
  checks.push({
    name: "claude-code scripts symlink resolves",
    ok: existsSync(pluginScripts),
    hint: existsSync(pluginScripts)
      ? undefined
      : "scripts/ symlink broken. Run: npm run build && memory install claude-code",
  });

  const claudePluginEnabled = await isClaudeCodePluginEnabled();
  checks.push({
    name: "claude-code plugin enabled",
    ok: claudePluginEnabled,
    hint: claudePluginEnabled
      ? undefined
      : "Run: memory install claude-code",
  });

  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;
  const clients = await getClientStatuses();
  return { checks, clients, passed, failed };
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines = result.checks.map(
    (check) => `${check.ok ? "ok" : "fail"} ${check.name}${check.hint ? ` - ${check.hint}` : ""}`,
  );
  lines.push("");
  lines.push("clients:");
  for (const client of result.clients) {
    lines.push(`  ${formatClientStatus(client)}`);
  }
  lines.push("");
  lines.push(
    `${result.passed}/${result.checks.length} checks passed${
      result.failed > 0 ? `; ${result.failed} failed` : ""
    }`,
  );
  return lines.join("\n");
}
