import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "../storage/atomic-write.js";

export type IndexGenerationState = "ready" | "invalidating";

export interface IndexGeneration {
  state: IndexGenerationState;
  token: string;
}

const DEFAULT_GENERATION: IndexGeneration = { state: "ready", token: "initial" };

export function indexGenerationPath(vaultRoot: string): string {
  return join(vaultRoot, "var", "index-generation");
}

/**
 * A dashboard checks this tiny generation fence before each indexed search.
 * An unreadable or malformed fence is treated as invalidating so it can never
 * allow a cached reader to serve material during an erase.
 */
export function readIndexGeneration(vaultRoot: string): IndexGeneration {
  const path = indexGenerationPath(vaultRoot);
  if (!existsSync(path)) return DEFAULT_GENERATION;
  const value = readFileSync(path, "utf8").trim();
  const match = /^(ready|invalidating):([A-Za-z0-9-]+)$/u.exec(value);
  if (!match) return { state: "invalidating", token: "unreadable" };
  return { state: match[1] as IndexGenerationState, token: match[2]! };
}

export async function beginIndexInvalidation(vaultRoot: string): Promise<IndexGeneration> {
  return writeIndexGeneration(vaultRoot, "invalidating");
}

export async function completeIndexInvalidation(vaultRoot: string): Promise<IndexGeneration> {
  return writeIndexGeneration(vaultRoot, "ready");
}

async function writeIndexGeneration(vaultRoot: string, state: IndexGenerationState): Promise<IndexGeneration> {
  const generation = { state, token: randomUUID() };
  await atomicWrite(indexGenerationPath(vaultRoot), `${generation.state}:${generation.token}\n`);
  return generation;
}
