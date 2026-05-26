import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface AgentMemoryKvEntry {
  scope: string;
  entryKey: string;
  key: string;
  value: unknown;
  filePath: string;
}

export async function readAgentMemoryKvStore(
  stateStoreDir: string,
): Promise<AgentMemoryKvEntry[]> {
  const entries: AgentMemoryKvEntry[] = [];
  const files = (await readdir(stateStoreDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".bin"))
    .map((entry) => entry.name)
    .sort();

  for (const file of files) {
    const filePath = join(stateStoreDir, file);
    const scope = decodeURIComponent(file.replace(/\.bin$/, ""));
    const decoded = decodeAgentMemoryValue(await readFile(filePath));
    if (!isRecord(decoded)) {
      entries.push({ scope, entryKey: "", key: scope, value: decoded, filePath });
      continue;
    }
    for (const [entryKey, value] of Object.entries(decoded)) {
      entries.push({
        scope,
        entryKey,
        key: `${scope}:${entryKey}`,
        value,
        filePath,
      });
    }
  }

  return entries;
}

export async function readAgentMemoryStoreDir(
  dataDir: string,
): Promise<AgentMemoryKvEntry[]> {
  const entries = await readAgentMemoryKvStore(join(dataDir, "state_store.db"));
  const streamDir = join(dataDir, "stream_store");
  try {
    entries.push(...(await readAgentMemoryKvStore(streamDir)));
  } catch {
    // Older fixtures or partial exports might not have stream_store.
  }
  return entries;
}

export function decodeAgentMemoryValue(buffer: Buffer): unknown {
  const text = buffer.toString("utf-8");
  const end = findJsonValueEnd(text);
  if (end === -1) {
    throw new Error("agentmemory kv: could not find a complete JSON value");
  }
  return JSON.parse(text.slice(0, end));
}

function findJsonValueEnd(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  let root: "{" | "[" | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!started) {
      if (/\s/.test(ch)) continue;
      if (ch !== "{" && ch !== "[") return -1;
      started = true;
      root = ch;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        const closesRoot = (root === "{" && ch === "}") || (root === "[" && ch === "]");
        return closesRoot ? i + 1 : -1;
      }
    }
  }

  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
