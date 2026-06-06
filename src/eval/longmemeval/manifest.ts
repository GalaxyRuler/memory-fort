import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

export interface LongMemEvalManifest {
  dataset: "longmemeval-s";
  version: string;
  sha256: string;
  sourceUrl: string;
  downloadedAt: string;
  questionCount: number;
}

export async function readManifest(
  path: string,
): Promise<LongMemEvalManifest | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as LongMemEvalManifest;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

export async function writeManifest(
  path: string,
  manifest: LongMemEvalManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function manifestMatches(
  manifest: LongMemEvalManifest | null,
  expectedSha256: string,
  sourceUrl: string,
): boolean {
  return manifest?.dataset === "longmemeval-s" &&
    manifest.sha256 === expectedSha256 &&
    manifest.sourceUrl === sourceUrl;
}
