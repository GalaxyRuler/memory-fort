import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { promoteProposedDraft } from "../../src/dashboard/proposed.js";

const root = requiredEnv("MEMORY_TEST_ROOT");
const readyPath = requiredEnv("MEMORY_TEST_PROMOTION_READY");
const releasePath = requiredEnv("MEMORY_TEST_PROMOTION_RELEASE");
const slug = requiredEnv("MEMORY_TEST_PROMOTION_SLUG");
const kind = requiredKindEnv("MEMORY_TEST_PROMOTION_KIND");
let paused = false;
const pauseAfterSnapshot = async () => {
  if (paused) return;
  paused = true;
  await writeFile(readyPath, "ready\n", "utf-8");
  while (!existsSync(releasePath)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const result = await promoteProposedDraft(root, kind, slug, {
  hooks: {
    afterCompileProposalSnapshot: pauseAfterSnapshot,
    afterProposalSnapshot: pauseAfterSnapshot,
  },
});

process.stdout.write(`${JSON.stringify(result)}\n`);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredKindEnv(name: string): "compile" | "thread" | "procedure" {
  const value = requiredEnv(name);
  if (value === "compile" || value === "thread" || value === "procedure") return value;
  throw new Error(`${name} must be compile, thread, or procedure`);
}
