import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "../storage/atomic-write.js";
import { withFileLock } from "../storage/file-lock.js";

export type IndexGenerationState = "ready" | "invalidating";

export interface IndexGeneration {
  state: IndexGenerationState;
  token: string;
}

const DEFAULT_GENERATION: IndexGeneration = { state: "ready", token: "initial" };

export class IndexGenerationOwnershipError extends Error {
  constructor(expectedToken: string, current: IndexGeneration) {
    super(
      `index generation ownership changed: expected invalidating:${expectedToken}, found ${current.state}:${current.token}`,
    );
    this.name = "IndexGenerationOwnershipError";
  }
}

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

export async function beginIndexInvalidation(
  vaultRoot: string,
  requestedToken?: string,
): Promise<IndexGeneration> {
  return withFileLock(
    indexGenerationPath(vaultRoot),
    () => writeIndexGeneration(vaultRoot, "invalidating", requestedToken),
  );
}

export async function completeIndexInvalidation(
  vaultRoot: string,
  expectedInvalidatingToken: string,
): Promise<IndexGeneration> {
  return withFileLock(indexGenerationPath(vaultRoot), async () => {
    const current = readIndexGeneration(vaultRoot);
    if (current.state !== "invalidating" || current.token !== expectedInvalidatingToken) {
      throw new IndexGenerationOwnershipError(expectedInvalidatingToken, current);
    }
    return writeIndexGeneration(vaultRoot, "ready");
  });
}

async function writeIndexGeneration(
  vaultRoot: string,
  state: IndexGenerationState,
  requestedToken?: string,
): Promise<IndexGeneration> {
  const token = requestedToken ?? randomUUID();
  if (!/^[A-Za-z0-9-]+$/u.test(token)) throw new Error("invalid index generation token");
  const generation = { state, token };
  await atomicWrite(indexGenerationPath(vaultRoot), `${generation.state}:${generation.token}\n`);
  return generation;
}
