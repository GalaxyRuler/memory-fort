import { readdir, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { memoryRoot, errorsLogPath } from "../../storage/paths.js";

export interface StatsResult {
  root: string;
  raw: { files: number; bytes: number; lastModified: Date | null };
  wiki: { files: number; bytes: number };
  crystals: { files: number; bytes: number };
  embeddings: { records: number; bytes: number };
  installs: {
    claudeCode: boolean;
    codex: boolean;
    antigravity: boolean;
  };
  errorsLogBytes: number;
  git: { initialized: boolean; commits: number; branch: string | null };
  capture?: {
    full: number;
    summary: number;
    metadata: number;
    skip: number;
    byteSavings: number;
  };
}

async function countDir(
  dir: string,
  extFilter?: string,
): Promise<{ files: number; bytes: number; lastModified: Date | null }> {
  if (!existsSync(dir)) return { files: 0, bytes: 0, lastModified: null };
  let files = 0;
  let bytes = 0;
  let lastModified: Date | null = null;

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        if (extFilter && !entry.name.endsWith(extFilter)) continue;
        const st = await stat(full);
        files++;
        bytes += st.size;
        if (!lastModified || st.mtime > lastModified) lastModified = st.mtime;
      }
    }
  }

  await walk(dir);
  return { files, bytes, lastModified };
}

async function countJsonlRecords(dir: string): Promise<{ records: number; bytes: number }> {
  if (!existsSync(dir)) return { records: 0, bytes: 0 };
  let records = 0;
  let bytes = 0;

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const st = await stat(full);
        bytes += st.size;
        const content = await readFile(full, "utf-8");
        records += content.split(/\r?\n/).filter((line) => line.length > 0).length;
      }
    }
  }

  await walk(dir);
  return { records, bytes };
}

export async function runStats(): Promise<StatsResult> {
  const root = memoryRoot();
  const raw = await countDir(join(root, "raw"), ".md");
  const wiki = await countDir(join(root, "wiki"), ".md");
  const crystals = await countDir(join(root, "crystals"), ".md");
  const embeddings = await countJsonlRecords(join(root, "embeddings"));
  const errorsBytes = existsSync(errorsLogPath())
    ? (await stat(errorsLogPath())).size
    : 0;

  const installs = {
    claudeCode: existsSync(join(root, "claude-code-plugin", ".mcp.json")),
    codex: false,
    antigravity: false,
  };

  try {
    const { homedir } = await import("node:os");
    const codexCfg = join(homedir(), ".codex", "config.toml");
    if (existsSync(codexCfg)) {
      const content = await readFile(codexCfg, "utf-8");
      installs.codex = /# === BEGIN memory-system/m.test(content);
    }
  } catch {
    // install detection is best-effort
  }

  try {
    const { homedir } = await import("node:os");
    const agCfg = join(homedir(), ".gemini", "antigravity", "mcp_config.json");
    if (existsSync(agCfg)) {
      const content = await readFile(agCfg, "utf-8");
      const parsed = JSON.parse(content) as {
        mcpServers?: Record<string, unknown>;
      };
      installs.antigravity = !!parsed.mcpServers && "memory" in parsed.mcpServers;
    }
  } catch {
    // install detection is best-effort
  }

  const gitInitialized = existsSync(join(root, ".git"));
  let commits = 0;
  let branch: string | null = null;
  if (gitInitialized) {
    try {
      const out = execFileSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      commits = parseInt(out, 10) || 0;
    } catch {
      // ignore
    }
    try {
      branch =
        execFileSync("git", ["branch", "--show-current"], {
          cwd: root,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() || null;
    } catch {
      // ignore
    }
  }

  return {
    root,
    raw,
    wiki,
    crystals,
    embeddings,
    installs,
    errorsLogBytes: errorsBytes,
    git: { initialized: gitInitialized, commits, branch },
  };
}

export function formatStatsResult(result: StatsResult): string {
  const fmt = (n: number) => n.toLocaleString();
  const fmtBytes = (n: number) =>
    n < 1024
      ? `${n} B`
      : n < 1024 * 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1024 / 1024).toFixed(1)} MB`;
  const lastMod = result.raw.lastModified
    ? result.raw.lastModified.toISOString().replace("T", " ").slice(0, 19)
    : "never";

  return [
    `Memory at ${result.root}`,
    ``,
    `Storage:`,
    `  raw/       ${fmt(result.raw.files).padStart(6)} files  ${fmtBytes(result.raw.bytes).padStart(8)}  (last: ${lastMod})`,
    `  wiki/      ${fmt(result.wiki.files).padStart(6)} files  ${fmtBytes(result.wiki.bytes).padStart(8)}`,
    `  crystals/  ${fmt(result.crystals.files).padStart(6)} files  ${fmtBytes(result.crystals.bytes).padStart(8)}`,
    `  embeddings ${fmt(result.embeddings.records).padStart(6)} records ${fmtBytes(result.embeddings.bytes).padStart(8)}`,
    ``,
    `Hooks installed: claude-code ${result.installs.claudeCode ? "yes" : "no"}   codex ${result.installs.codex ? "yes" : "no"}   antigravity ${result.installs.antigravity ? "yes" : "no"}`,
    ``,
    `errors.log: ${fmtBytes(result.errorsLogBytes)}${result.errorsLogBytes === 0 ? " (clean)" : ""}`,
    ``,
    `Git: ${
      result.git.initialized
        ? `branch ${result.git.branch ?? "?"}, ${fmt(result.git.commits)} commits`
        : "not initialized"
    }`,
    ``,
    ...(result.capture
      ? [
          `Capture modes: ${fmt(result.capture.full)} full  ${fmt(result.capture.summary)} summary  ${fmt(result.capture.metadata)} metadata  ${fmt(result.capture.skip)} skip`,
          `  byte savings: ${fmtBytes(result.capture.byteSavings)}`,
          ``,
        ]
      : []),
  ].join("\n");
}
