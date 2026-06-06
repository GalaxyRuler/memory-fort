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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

if (hookName === "session_start") emitSessionStartContext(input, memoryRoot);
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

function emitSessionStartContext(payload, root) {
  const parts = ["[memory:session-start] context loading\\n"];
  try {
    const projectBlock = currentProjectMemoryBlock(root, stringField(payload, "cwd") || stringField(payload, "working_directory"));
    if (projectBlock.trim().length > 0) parts.push("\\n" + projectBlock.trim() + "\\n");
  } catch {
    // Project context is opportunistic; keep the schema/index/log fallback.
  }
  appendContextSection(parts, "Schema", join(root, "schema.md"));
  appendContextSection(parts, "Index", join(root, "index.md"));
  appendContextSection(parts, "Recent log", join(root, "log.md"), 20);
  process.stdout.write(parts.join(""));
}

function appendContextSection(parts, label, path, tail) {
  try {
    const content = readFileSync(path, "utf-8");
    const body = tail ? lastLines(content, tail) : content;
    parts.push("\\n--- " + label + " (" + path + ") ---\\n" + body.trim() + "\\n");
  } catch {
    // Missing files are normal on fresh installs.
  }
}

function currentProjectMemoryBlock(root, cwd) {
  if (!cwd) return "";
  const projectRelPath = resolveProjectForCwd(cwd, root);
  if (!projectRelPath) return "";
  const project = parseFrontmatter(readFileSync(join(root, ...projectRelPath.split("/")), "utf-8"));
  const indexEntries = parseIndexEntries(safeRead(join(root, "index.md")));
  const related = collectRelatedEntries(root, projectRelPath, project.frontmatterText, project.body, indexEntries);
  const block = [
    formatCurrentProjectSection(projectRelPath, project.frontmatterText, project.body),
    formatRelatedMemorySection(related),
  ].join("\\n");
  return truncateWithMarker(block, 8000);
}

function resolveProjectForCwd(cwd, root) {
  const projects = listProjectCandidates(root);
  if (projects.length === 0) return "";
  const cwdKey = normalizeMatchPath(cwd);
  const repoMatches = [];
  for (const project of projects) {
    const parsed = parseFrontmatter(safeRead(project.fullPath));
    for (const repoPath of readRepoPaths(parsed.frontmatterText)) {
      const repoKey = normalizeMatchPath(repoPath);
      if (repoKey.length > 0 && (cwdKey === repoKey || cwdKey.startsWith(repoKey + "/"))) {
        repoMatches.push({ relPath: project.relPath, length: repoKey.length });
      }
    }
  }
  const bestRepoLength = Math.max(0, ...repoMatches.map((match) => match.length));
  if (bestRepoLength > 0) {
    const winners = [...new Set(repoMatches.filter((match) => match.length === bestRepoLength).map((match) => match.relPath))];
    return winners.length === 1 ? winners[0] : "";
  }

  const ignored = new Set(["src", ".claude", "worktrees", "node_modules"]);
  const segments = cwdKey.split("/").filter(Boolean);
  const slugMatches = [];
  for (const project of projects) {
    const slug = project.slug.toLowerCase();
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!ignored.has(segment) && segment === slug) slugMatches.push({ relPath: project.relPath, depth: index });
    }
  }
  const deepest = Math.max(-1, ...slugMatches.map((match) => match.depth));
  if (deepest < 0) return "";
  const winners = [...new Set(slugMatches.filter((match) => match.depth === deepest).map((match) => match.relPath))];
  return winners.length === 1 ? winners[0] : "";
}

function listProjectCandidates(root) {
  try {
    return readdirSync(join(root, "wiki", "projects"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 500)
      .map((entry) => {
        const slug = entry.name.slice(0, -3);
        return {
          slug,
          relPath: "wiki/projects/" + entry.name,
          fullPath: join(root, "wiki", "projects", entry.name),
        };
      });
  } catch {
    return [];
  }
}

function collectRelatedEntries(root, projectRelPath, frontmatterText, body, indexEntries) {
  const indexByPath = new Map(indexEntries.map((entry) => [entry.path, entry]));
  const indexBySlug = buildIndexBySlug(indexEntries);
  const candidates = [...relationTargets(frontmatterText), ...wikilinkTargets(body)];
  const seen = new Set();
  const related = [];
  for (const candidate of candidates) {
    const relPath = resolveMemoryReference(candidate, indexBySlug);
    if (!relPath || relPath === projectRelPath || seen.has(relPath)) continue;
    seen.add(relPath);
    const indexEntry = indexByPath.get(relPath) || {
      path: relPath,
      title: titleFromRelPath(relPath),
      summary: titleFromRelPath(relPath),
    };
    const meta = readRelatedMetadata(root, relPath);
    related.push({ ...indexEntry, ...meta });
  }
  return related.sort((a, b) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    if (b.recency !== a.recency) return b.recency - a.recency;
    return a.title.localeCompare(b.title) || a.path.localeCompare(b.path);
  });
}

function parseFrontmatter(content) {
  if (!content.startsWith("---")) return { frontmatterText: "", body: content };
  const end = content.indexOf("\\n---", 3);
  if (end < 0) return { frontmatterText: "", body: content };
  const closeEnd = content.indexOf("\\n", end + 4);
  return {
    frontmatterText: content.slice(3, end).trim(),
    body: content.slice(closeEnd < 0 ? end + 4 : closeEnd + 1),
  };
}

function readRepoPaths(frontmatterText) {
  const paths = [];
  const repo = frontmatterField(frontmatterText, "repo");
  if (repo) paths.push(repo);
  paths.push(...frontmatterArray(frontmatterText, "repo_paths"));
  return paths;
}

function relationTargets(frontmatterText) {
  const lines = frontmatterText.split(/\\r?\\n/);
  const targets = [];
  let inRelations = false;
  for (const line of lines) {
    if (/^relations:[ \\t]*$/.test(line)) {
      inRelations = true;
      continue;
    }
    if (inRelations && /^[A-Za-z_][A-Za-z0-9_-]*:/.test(line)) break;
    if (!inRelations) continue;
    const listMatch = line.match(/^[ \\t]*-[ \\t]*(?:target:[ \\t]*)?(.+?)[ \\t]*$/);
    const targetMatch = line.match(/^[ \\t]*target:[ \\t]*(.+?)[ \\t]*$/);
    const target = cleanScalar((listMatch && listMatch[1]) || (targetMatch && targetMatch[1]) || "");
    if (target) targets.push(target);
  }
  return targets;
}

function wikilinkTargets(body) {
  const targets = [];
  const re = /\\[\\[([^\\]|#]+)(?:#[^\\]|]*)?(?:\\|[^\\]]*)?\\]\\]/g;
  for (const match of body.matchAll(re)) targets.push(match[1]);
  return targets;
}

function parseIndexEntries(indexContent) {
  const entries = [];
  for (const line of indexContent.split(/\\r?\\n/)) {
    const markdown = line.match(/^-[ \\t]+\\[([^\\]]+)\\]\\(([^)#]+)(?:#[^)]+)?\\)[ \\t]+-[ \\t]*(.*)$/);
    if (markdown) {
      const path = normalizeReferencePath(markdown[2]);
      if (path) entries.push({ title: markdown[1].trim(), path, summary: markdown[3].trim() });
      continue;
    }
    const wiki = line.match(/^-[ \\t]+\\[\\[([^\\]|#]+)(?:#[^\\]|]*)?(?:\\|([^\\]]+))?\\]\\][ \\t]*(?:-[ \\t]*)?(.*)$/);
    if (wiki) {
      const path = normalizeReferencePath(wiki[1]);
      if (path) entries.push({ title: (wiki[2] || titleFromRelPath(path)).trim(), path, summary: wiki[3].trim() || titleFromRelPath(path) });
    }
  }
  return entries;
}

function buildIndexBySlug(entries) {
  const result = new Map();
  for (const entry of entries) {
    const slug = fileBase(entry.path).replace(/\\.md$/, "").toLowerCase();
    result.set(slug, result.has(slug) ? null : entry.path);
  }
  return result;
}

function resolveMemoryReference(value, indexBySlug) {
  const normalized = normalizeReferencePath(value);
  if (!normalized) return "";
  if (normalized.includes("/")) return normalized;
  return indexBySlug.get(normalized.toLowerCase()) || "";
}

function normalizeReferencePath(value) {
  let normalized = String(value || "").trim().replace(/\\\\/g, "/").replace(/^\\.\\//, "").replace(/^\\/+/, "").replace(/#.*$/, "");
  if (!normalized) return "";
  if (!normalized.endsWith(".md") && normalized.includes("/")) normalized += ".md";
  const first = normalized.split("/")[0];
  if (["projects", "people", "decisions", "lessons", "references", "tools", "threads", "procedures", "prospective"].includes(first)) {
    return "wiki/" + normalized;
  }
  if (normalized.startsWith("wiki/") || normalized.startsWith("crystals/")) return normalized;
  return normalized;
}

function readRelatedMetadata(root, relPath) {
  const parsed = parseFrontmatter(safeRead(join(root, ...relPath.split("/"))));
  const strengthRaw = Number(frontmatterField(parsed.frontmatterText, "strength") || "0");
  const strength = Number.isFinite(strengthRaw) ? strengthRaw : 0;
  const recency = timestampToSortKey(frontmatterField(parsed.frontmatterText, "last_accessed") || frontmatterField(parsed.frontmatterText, "updated") || "");
  return { strength, recency };
}

function formatCurrentProjectSection(relPath, frontmatterText, body) {
  const lines = ["--- Current project memory (" + relPath + ") ---"];
  const title = frontmatterField(frontmatterText, "title");
  const status = frontmatterField(frontmatterText, "status");
  const updated = frontmatterField(frontmatterText, "updated");
  if (title) lines.push("title: " + title);
  if (status) lines.push("status: " + status);
  if (updated) lines.push("updated: " + updated);
  lines.push("", body.trim(), "");
  return lines.join("\\n");
}

function formatRelatedMemorySection(entries) {
  const lines = ["--- Related memory ---"];
  if (entries.length === 0) {
    lines.push("(none found)");
    return lines.join("\\n") + "\\n";
  }
  const top = entries.slice(0, 5);
  const rest = entries.slice(5);
  lines.push(...top.map((entry) => "- " + entry.title + " (" + entry.path + "): " + entry.summary));
  if (rest.length > 0) {
    lines.push("more:");
    lines.push(...rest.map((entry) => "- " + entry.title));
  }
  return lines.join("\\n") + "\\n";
}

function frontmatterField(frontmatterText, name) {
  const re = new RegExp("^" + name + ":[ \\\\t]*(.+)$", "m");
  const match = frontmatterText.match(re);
  return cleanScalar(match ? match[1] : "");
}

function frontmatterArray(frontmatterText, name) {
  const lines = frontmatterText.split(/\\r?\\n/);
  const values = [];
  let inField = false;
  for (const line of lines) {
    if (new RegExp("^" + name + ":[ \\\\t]*$").test(line)) {
      inField = true;
      continue;
    }
    if (inField && /^[A-Za-z_][A-Za-z0-9_-]*:/.test(line)) break;
    if (!inField) continue;
    const match = line.match(/^[ \\t]*-[ \\t]*(.+?)[ \\t]*$/);
    if (match) values.push(cleanScalar(match[1]));
  }
  return values.filter(Boolean);
}

function cleanScalar(value) {
  let cleaned = String(value || "").trim();
  if (!cleaned) return "";
  if ((cleaned.startsWith("\\"") && cleaned.endsWith("\\"")) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned;
}

function normalizeMatchPath(value) {
  return String(value || "").trim().replace(/\\\\/g, "/").replace(/\\/+/g, "/").replace(/\\/+$/, "").toLowerCase();
}

function titleFromRelPath(relPath) {
  return fileBase(relPath).replace(/\\.md$/, "").replace(/[-_]+/g, " ").replace(/\\b\\w/g, (char) => char.toUpperCase());
}

function fileBase(value) {
  const normalized = String(value || "").replace(/\\\\/g, "/");
  return normalized.split("/").pop() || normalized;
}

function truncateWithMarker(text, maxChars) {
  const marker = "\\n(truncated, use MCP read_page for full)";
  if (text.length <= maxChars) return text;
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  return text.slice(0, maxChars - marker.length).trimEnd() + marker;
}

function lastLines(text, n) {
  const lines = text.split(/\\r?\\n/);
  return lines.slice(Math.max(0, lines.length - n)).join("\\n");
}

function timestampToSortKey(value) {
  if (!value) return 0;
  const normalized = /^\\d{4}-\\d{2}-\\d{2}$/.test(value) ? value + "T00:00:00.000Z" : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}
`;
}
