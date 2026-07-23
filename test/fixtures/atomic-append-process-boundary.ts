import { open, writeFile } from "node:fs/promises";
import { atomicAppend } from "../../src/storage/atomic-write.js";

const target = requiredEnv("MEMORY_TEST_APPEND_TARGET");
const syncMarker = requiredEnv("MEMORY_TEST_SYNC_MARKER");
let syncCompleted = false;

await atomicAppend(target, "child-process capture\n", async (path, content, options) => {
  if (options.flush !== true) throw new Error("atomic append did not request a flush");
  const handle = await open(path, "a");
  try {
    await handle.writeFile(content, options.encoding);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await handle.sync();
    await writeFile(syncMarker, "sync completed\n", "utf-8");
    syncCompleted = true;
  } finally {
    await handle.close();
  }
});

if (!syncCompleted) {
  throw new Error("atomicAppend returned before the injected sync boundary completed");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
