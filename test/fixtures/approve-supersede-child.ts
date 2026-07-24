import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { applyApprovedSupersedeProposal } from "../../src/compile/approve-supersede.js";

const root = requiredEnv("MEMORY_TEST_ROOT");
const proposalPath = requiredEnv("MEMORY_TEST_APPROVAL_PROPOSAL");
const readyPath = requiredEnv("MEMORY_TEST_APPROVAL_READY");
const releasePath = requiredEnv("MEMORY_TEST_APPROVAL_RELEASE");

const result = await applyApprovedSupersedeProposal({
  vaultRoot: root,
  proposalPath,
  hooks: {
    afterProposalAndCanonicalSnapshot: async () => {
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
