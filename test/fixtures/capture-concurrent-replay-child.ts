import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appendBlock } from "../../src/hooks/raw-file.js";

const readyFile = requiredEnv("MEMORY_TEST_READY_FILE");
const startFile = requiredEnv("MEMORY_TEST_START_FILE");
const sessionId = requiredEnv("MEMORY_TEST_SESSION_ID");
await mkdir(dirname(readyFile), { recursive: true });
await writeFile(readyFile, "ready", "utf-8");
await waitForFile(startFile);
await appendBlock({
  tool: "codex",
  sessionId,
  block: "\n## [04:00:01] Prompt\n\nconcurrent hook completed\n",
  now: new Date("2026-07-23T04:00:01.000Z"),
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error("replay start signal was not written");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
