import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { promoteProposedDraft } from "../../src/dashboard/proposed.js";

const root = requiredEnv("MEMORY_TEST_ROOT");
const readyPath = requiredEnv("MEMORY_TEST_PROMOTION_READY");
const releasePath = requiredEnv("MEMORY_TEST_PROMOTION_RELEASE");
const slug = requiredEnv("MEMORY_TEST_PROMOTION_SLUG");

const result = await promoteProposedDraft(root, "compile", slug, {
  hooks: {
    afterCompileProposalSnapshot: async () => {
      await writeFile(readyPath, "ready\n", "utf-8");
      while (!existsSync(releasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  },
});

process.stdout.write(`${JSON.stringify(result)}\n`);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
