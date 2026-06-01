import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const narrativeSource = read("src/compile/synthesize-narrative.ts");
const detectPrompt = read("src/compile/prompts/narrative-detect-system.md");
const synthesizePrompt = read("src/compile/prompts/narrative-synthesize-system.md");

const checks = [
  [narrativeSource.includes("NarrativeDetectOutput"), "narrative detect schema name present"],
  [narrativeSource.includes("contradicted_claims") && narrativeSource.includes("net_new_facts"), "narrative detect schema fields present"],
  [narrativeSource.includes("NarrativeSynthesisOutput"), "narrative synthesis schema name present"],
  [narrativeSource.includes("validateNarrativeBody"), "narrative body validator present"],
  [narrativeSource.includes("source_facts") && narrativeSource.includes("last_accessed") && narrativeSource.includes("strength"), "narrative frontmatter fields present"],
  [detectPrompt.includes("contradicted existing claims") && detectPrompt.includes("accepted compressed facts"), "narrative detect prompt intent present"],
  [synthesizePrompt.includes("You are a memory consolidation engine."), "narrative synthesis prompt identity present"],
  [synthesizePrompt.includes("No `## headings`") && synthesizePrompt.includes("no `- bullets`") && synthesizePrompt.includes("no `[x] checkboxes`"), "narrative synthesis prompt structural bans present"],
  [synthesizePrompt.includes("Additional Information") && synthesizePrompt.includes("Code handles those"), "narrative synthesis prompt metadata ban present"],
  [narrativeSource.includes("NARRATIVE_DETECT_SYSTEM_PROMPT") && narrativeSource.includes("NARRATIVE_SYNTHESIS_SYSTEM_PROMPT"), "narrative prompt constants wired"],
];

const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
if (failed.length > 0) {
  throw new Error(`prompt drift check failed: ${failed.join("; ")}`);
}

function read(relPath) {
  return readFileSync(join(root, relPath), "utf-8");
}
