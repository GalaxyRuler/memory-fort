import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { memoryRoot as defaultMemoryRoot } from "./paths.js";

export interface MemoryConfig {
  voyage?: {
    api_key?: string;
  };
  vps?: {
    host?: string;
    install_root?: string;
    ssh_user?: string;
  };
  search?: {
    hyde?: boolean;
  };
  [key: string]: unknown;
}

export async function loadMemoryConfig(
  memoryRoot?: string,
): Promise<MemoryConfig> {
  const root = memoryRoot ?? defaultMemoryRoot();
  try {
    return parseYamlSubset(await readFile(join(root, "config.yaml"), "utf-8"));
  } catch (error) {
    if (isMissingFile(error)) return {};
    console.warn(
      `Warning: failed to parse config.yaml: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
}

type YamlObject = Record<string, unknown>;

function parseYamlSubset(text: string): MemoryConfig {
  const root: YamlObject = {};
  let currentSection: YamlObject | null = null;

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    if (rawLine.includes("\t")) {
      throw new Error(`line ${index + 1}: tabs are not supported`);
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if (indent === 0) {
      const { key, value } = splitKeyValue(line, index + 1);
      if (value === "") {
        const section: YamlObject = {};
        root[key] = section;
        currentSection = section;
      } else {
        root[key] = parseScalar(value, index + 1);
        currentSection = null;
      }
      continue;
    }

    if (indent !== 2 || currentSection === null) {
      throw new Error(`line ${index + 1}: unsupported indentation`);
    }
    const { key, value } = splitKeyValue(line, index + 1);
    if (value === "") {
      throw new Error(`line ${index + 1}: nested sections are not supported`);
    }
    currentSection[key] = parseScalar(value, index + 1);
  }

  return root as MemoryConfig;
}

function splitKeyValue(line: string, lineNumber: number): { key: string; value: string } {
  const colon = line.indexOf(":");
  if (colon <= 0) {
    throw new Error(`line ${lineNumber}: expected key: value`);
  }
  const key = line.slice(0, colon).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error(`line ${lineNumber}: invalid key`);
  }
  return { key, value: line.slice(colon + 1).trim() };
}

function parseScalar(value: string, lineNumber: number): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"')) return parseDoubleQuoted(value, lineNumber);
  if (value.startsWith("'")) return parseSingleQuoted(value, lineNumber);
  if (value.startsWith("[") || value.endsWith("]")) {
    return parseInlineArray(value, lineNumber);
  }
  if (value.includes('"') || value.includes("'")) {
    throw new Error(`line ${lineNumber}: malformed quoted string`);
  }
  return value;
}

function parseDoubleQuoted(value: string, lineNumber: number): string {
  if (!value.endsWith('"') || value.length === 1) {
    throw new Error(`line ${lineNumber}: unterminated double-quoted string`);
  }
  try {
    return JSON.parse(value) as string;
  } catch (error) {
    throw new Error(
      `line ${lineNumber}: invalid double-quoted string: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseSingleQuoted(value: string, lineNumber: number): string {
  if (!value.endsWith("'") || value.length === 1) {
    throw new Error(`line ${lineNumber}: unterminated single-quoted string`);
  }
  return value.slice(1, -1).replace(/''/g, "'");
}

function parseInlineArray(value: string, lineNumber: number): unknown[] {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw new Error(`line ${lineNumber}: malformed inline array`);
  }
  const inner = value.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(",").map((item) => parseScalar(item.trim(), lineNumber));
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
