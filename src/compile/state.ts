import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../storage/atomic-write.js";

export interface CompileConsumedWatermark {
  bytes: number;
  lastObservationAt?: string;
}

export interface CompileStateFile {
  status?: string;
  lastRun?: unknown;
  consumed?: Record<string, CompileConsumedWatermark>;
  [key: string]: unknown;
}

export function compileStatePath(vaultRoot: string): string {
  return join(vaultRoot, "state", "compile-state.json");
}

export async function readCompileStateFile(vaultRoot: string): Promise<CompileStateFile> {
  const path = compileStatePath(vaultRoot);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as CompileStateFile
    : {};
}

export async function writeCompileStateFile(vaultRoot: string, state: CompileStateFile): Promise<void> {
  await atomicWrite(compileStatePath(vaultRoot), `${JSON.stringify(state, null, 2)}\n`);
}

export function readConsumedMap(state: CompileStateFile): Record<string, CompileConsumedWatermark> {
  const consumed = state.consumed;
  if (!consumed || typeof consumed !== "object" || Array.isArray(consumed)) return {};
  const normalized: Record<string, CompileConsumedWatermark> = {};
  for (const [path, value] of Object.entries(consumed) as Array<[string, unknown]>) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const bytes = record["bytes"];
    const lastObservationAt = record["lastObservationAt"];
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) continue;
    normalized[path] = {
      bytes: Math.floor(bytes),
      ...(typeof lastObservationAt === "string" ? { lastObservationAt } : {}),
    };
  }
  return normalized;
}
