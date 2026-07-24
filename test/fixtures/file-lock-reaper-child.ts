import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { withFileLock } from "../../src/storage/file-lock.js";

const id = requiredEnv("MEMORY_TEST_REAPER_ID");
const target = requiredEnv("MEMORY_TEST_LOCK_TARGET");
const startPath = requiredEnv("MEMORY_TEST_REAPER_START");
const reclaimReleasePath = requiredEnv("MEMORY_TEST_RECLAIM_RELEASE");
const operationReleasePath = requiredEnv("MEMORY_TEST_LOCK_RELEASE");

process.stdout.write(`READY:${id}\n`);
while (!existsSync(startPath)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

await withFileLock(target, async () => {
  const owner = JSON.parse(await readFile(`${target}.lock`, "utf-8")) as { ownerToken?: unknown };
  process.stdout.write(`ENTERED:${id}:${String(owner.ownerToken)}\n`);
  while (!existsSync(operationReleasePath)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}, {
  timeoutMs: 10_000,
  staleMs: 20,
  pollMs: 10,
  testHooks: {
    afterStaleSnapshotConfirmed: async () => {
      process.stdout.write(`SNAPSHOT:${id}\n`);
      while (!existsSync(reclaimReleasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    afterStaleReclaimed: async () => {
      process.stdout.write(`RECLAIMED:${id}\n`);
    },
  },
});

process.stdout.write(`RELEASED:${id}\n`);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
