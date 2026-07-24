import { existsSync } from "node:fs";
import { withFileLock } from "../../src/storage/file-lock.js";

const target = requiredEnv("MEMORY_TEST_LOCK_TARGET");
const releasePath = requiredEnv("MEMORY_TEST_LOCK_RELEASE");
const staleMs = requiredNumberEnv("MEMORY_TEST_LOCK_STALE_MS");
const heartbeatMs = requiredNumberEnv("MEMORY_TEST_LOCK_HEARTBEAT_MS");

await withFileLock(target, async () => {
  process.stdout.write("LOCKED\n");
  while (!existsSync(releasePath)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}, {
  timeoutMs: 2_000,
  staleMs,
  heartbeatMs,
  pollMs: 10,
});

process.stdout.write("RELEASED\n");

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
