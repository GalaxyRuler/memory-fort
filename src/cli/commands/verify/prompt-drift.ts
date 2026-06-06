import { findPromptDrift } from "../../../prompts/runtime.js";
import { pass, warn, type CheckDescriptor, type VerifyCheckResult } from "./types.js";

const ID = "prompt.drift";

export const promptDriftCheck: CheckDescriptor = {
  id: ID,
  label: "runtime prompt drift",
  roles: ["operator", "server"],
  run: (ctx) => checkPromptDrift({ vaultRoot: ctx.vaultRoot }),
};

export async function checkPromptDrift(opts: {
  vaultRoot: string;
  sourceRepoDir?: string;
}): Promise<VerifyCheckResult> {
  const drifted = await findPromptDrift(opts);
  if (drifted.length === 0) {
    return pass(ID, "prompt drift: vault prompts match bundled templates or are customized");
  }
  return warn(
    ID,
    `prompt drift: ${drifted.length} uncustomized vault prompt${drifted.length === 1 ? "" : "s"} differ from bundled templates`,
    drifted.join(", "),
    "Run `memory sync-prompts --apply` to refresh uncustomized vault prompts, or add `# memory:custom` to intentionally customized prompts.",
  );
}
