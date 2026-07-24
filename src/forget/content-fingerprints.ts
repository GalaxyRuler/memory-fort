import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const CONTENT_FINGERPRINT_ALGORITHM = "sha256-normalized-text-v1" as const;
export const DEFAULT_CONTENT_FINGERPRINT_LIMIT = 4096;

export interface ContentFingerprintEvidence {
  readonly algorithm: typeof CONTENT_FINGERPRINT_ALGORITHM;
  readonly normalization: "unicode-nfc-trim-collapse-whitespace; yaml-frontmatter-excluded";
  readonly coverageComplete: boolean;
  readonly count: number;
  readonly totalCount: number;
  readonly maxCount: number;
  readonly hashes: string[];
}

export interface FingerprintScrubResult {
  readonly matched: boolean;
  readonly content: Buffer | null;
}

interface TextBlock {
  readonly start: number;
  readonly end: number;
  readonly normalized: string;
}

export async function collectSelectedContentFingerprints(
  root: string,
  rawPaths: readonly string[],
  maxCount = DEFAULT_CONTENT_FINGERPRINT_LIMIT,
): Promise<ContentFingerprintEvidence> {
  if (!Number.isSafeInteger(maxCount) || maxCount < 1) {
    throw new Error("memory forget: evidence fingerprint limit must be a positive integer");
  }
  const hashes = new Set<string>();
  for (const relPath of [...new Set(rawPaths)].sort((left, right) => left.localeCompare(right))) {
    const content = await readFile(join(root, ...relPath.split("/")), "utf8");
    for (const fingerprint of fingerprintsForSelectedText(content)) hashes.add(fingerprint);
  }
  const all = [...hashes].sort((left, right) => left.localeCompare(right));
  const retained = all.slice(0, maxCount);
  return {
    algorithm: CONTENT_FINGERPRINT_ALGORITHM,
    normalization: "unicode-nfc-trim-collapse-whitespace; yaml-frontmatter-excluded",
    coverageComplete: all.length <= maxCount,
    count: retained.length,
    totalCount: all.length,
    maxCount,
    hashes: retained,
  };
}

export function scrubSelectedContentFingerprints(
  content: Buffer,
  evidence: ContentFingerprintEvidence,
): FingerprintScrubResult {
  if (content.includes(0)) return { matched: false, content };
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) return { matched: false, content };
  const hasBom = text.startsWith("\uFEFF");
  const sourceText = hasBom ? text.slice(1) : text;
  const lineEnding = sourceText.includes("\r\n") ? "\r\n" : "\n";
  const lines = sourceText.split(/\r?\n/u);
  const bodyStart = yamlBodyStart(lines);
  const selected = selectedFingerprintSets(evidence);
  const remove = new Set<number>();

  for (let index = bodyStart; index < lines.length; index += 1) {
    const normalized = normalizeUnit(lines[index]!);
    if (isMeaningfulUnit(normalized) && selected.lines.has(hashUnit("line", normalized))) {
      remove.add(index);
    }
  }
  for (const block of textBlocks(lines.slice(bodyStart))) {
    if (selected.blocks.has(hashUnit("block", block.normalized))) {
      for (let index = block.start; index <= block.end; index += 1) {
        remove.add(bodyStart + index);
      }
    }
  }
  if (remove.size === 0) return { matched: false, content };

  const retained = lines.filter((_line, index) => !remove.has(index));
  const retainedText = retained.join(lineEnding);
  if (!hasMeaningfulBody(retained)) return { matched: true, content: null };
  return {
    matched: true,
    content: Buffer.from(`${hasBom ? "\uFEFF" : ""}${retainedText}`, "utf8"),
  };
}

export function hasSelectedContentFingerprint(
  content: Buffer,
  evidence: ContentFingerprintEvidence,
): boolean {
  return scrubSelectedContentFingerprints(content, evidence).matched;
}

export function isContentFingerprintEvidence(value: unknown): value is ContentFingerprintEvidence {
  if (!isRecord(value)
    || value["algorithm"] !== CONTENT_FINGERPRINT_ALGORITHM
    || value["normalization"] !== "unicode-nfc-trim-collapse-whitespace; yaml-frontmatter-excluded"
    || typeof value["coverageComplete"] !== "boolean"
    || !Number.isSafeInteger(value["count"])
    || !Number.isSafeInteger(value["totalCount"])
    || !Number.isSafeInteger(value["maxCount"])
    || !Array.isArray(value["hashes"])
    || !value["hashes"].every((entry) =>
      typeof entry === "string" && /^(?:line|block):sha256:[0-9a-f]{64}$/u.test(entry),
    )) {
    return false;
  }
  const hashes = value["hashes"] as string[];
  const count = value["count"] as number;
  const totalCount = value["totalCount"] as number;
  const maxCount = value["maxCount"] as number;
  const coverageComplete = value["coverageComplete"] as boolean;
  return count === hashes.length
    && count >= 0
    && totalCount >= 0
    && maxCount >= 1
    && count <= totalCount
    && count <= maxCount
    && new Set(hashes).size === hashes.length
    && hashes.every((entry, index) => index === 0 || hashes[index - 1]!.localeCompare(entry) < 0)
    && (coverageComplete
      ? count === totalCount
      : totalCount > count);
}

function fingerprintsForSelectedText(content: string): string[] {
  const body = stripYamlFrontmatter(content.replace(/^\uFEFF/u, "").split(/\r?\n/u));
  const hashes = new Set<string>();
  for (const line of body) {
    const normalized = normalizeUnit(line);
    if (isMeaningfulUnit(normalized)) hashes.add(hashUnit("line", normalized));
  }
  for (const block of textBlocks(body)) hashes.add(hashUnit("block", block.normalized));
  return [...hashes];
}

function stripYamlFrontmatter(lines: readonly string[]): string[] {
  return lines.slice(yamlBodyStart(lines));
}

function yamlBodyStart(lines: readonly string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  return end < 0 ? 0 : end + 2;
}

function textBlocks(lines: readonly string[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  let start: number | null = null;
  for (let index = 0; index <= lines.length; index += 1) {
    const normalized = index < lines.length ? normalizeUnit(lines[index]!) : "";
    if (normalized && start === null) start = index;
    if (normalized || start === null) continue;
    const units = lines
      .slice(start, index)
      .map(normalizeUnit)
      .filter(Boolean);
    const block = units.join("\n");
    if (isMeaningfulUnit(block)) blocks.push({ start, end: index - 1, normalized: block });
    start = null;
  }
  return blocks;
}

function hasMeaningfulBody(lines: readonly string[]): boolean {
  return stripYamlFrontmatter(lines).some((line) => normalizeUnit(line).length > 0);
}

function selectedFingerprintSets(evidence: ContentFingerprintEvidence): {
  lines: Set<string>;
  blocks: Set<string>;
} {
  return {
    lines: new Set(evidence.hashes.filter((value) => value.startsWith("line:"))),
    blocks: new Set(evidence.hashes.filter((value) => value.startsWith("block:"))),
  };
}

function normalizeUnit(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function isMeaningfulUnit(value: string): boolean {
  return value.length > 0 && /[\p{L}\p{N}]/u.test(value);
}

function hashUnit(kind: "line" | "block", normalized: string): string {
  return `${kind}:sha256:${createHash("sha256")
    .update(`memory-fort-selected-${kind}-v1\0${normalized}`, "utf8")
    .digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
