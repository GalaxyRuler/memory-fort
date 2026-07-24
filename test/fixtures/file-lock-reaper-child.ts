import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withFileLock } from "../../src/storage/file-lock.js";

const id = requiredEnv("MEMORY_TEST_REAPER_ID");
const target = requiredEnv("MEMORY_TEST_LOCK_TARGET");
const startPath = requiredEnv("MEMORY_TEST_REAPER_START");
const holdMs = requiredNumberEnv("MEMORY_TEST_REAPER_HOLD_MS");
const eventDirectory = requiredEnv("MEMORY_TEST_REAPER_EVENT_DIR");
const criticalGuard = requiredEnv("MEMORY_TEST_REAPER_CRITICAL_GUARD");
const snapshotReleasePath = process.env["MEMORY_TEST_REAPER_SNAPSHOT_RELEASE"];
await mkdir(eventDirectory, { recursive: true });

process.stdout.write(`READY:${id}\n`);
while (!existsSync(startPath)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

let snapshotReported = false;
await withFileLock(target, async () => {
  const ownerToken = await ownClaimToken(`${target}.lock`);
  let guard: Awaited<ReturnType<typeof open>> | null = null;
  try {
    guard = await open(criticalGuard, "wx");
    await writeFile(join(eventDirectory, `entered-${id}`), `${ownerToken}\n`, "utf-8");
    process.stdout.write(`ENTERED:${id}:${ownerToken}\n`);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  } finally {
    if (guard) {
      await guard.close().catch(() => undefined);
      await unlink(criticalGuard).catch(() => undefined);
      await writeFile(join(eventDirectory, `released-${id}`), "released\n", "utf-8");
    }
  }
}, {
  timeoutMs: 10_000,
  staleMs: 20,
  pollMs: 10,
  testHooks: {
    afterStaleSnapshotConfirmed: async () => {
      if (snapshotReported) return;
      snapshotReported = true;
      process.stdout.write(`SNAPSHOT:${id}\n`);
      if (snapshotReleasePath) {
        while (!existsSync(snapshotReleasePath)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    },
    afterStaleReclaimed: async () => {
      process.stdout.write(`RECLAIMED:${id}\n`);
    },
  },
});

process.stdout.write(`RELEASED:${id}\n`);

async function ownClaimToken(directory: string): Promise<string> {
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    try {
      const claim = JSON.parse(await readFile(join(directory, name), "utf-8")) as {
        pid?: unknown;
        ownerToken?: unknown;
      };
      if (claim.pid === process.pid && typeof claim.ownerToken === "string") return claim.ownerToken;
    } catch {
      // Another owner can release between the directory snapshot and this read.
    }
  }
  throw new Error("own unique lock claim is unavailable");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredNumberEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
