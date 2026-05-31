import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const plannerPrompt = read("src/compile/prompts/planner-system.md");
const rendererPrompt = read("src/compile/prompts/renderer-system.md");
const plannerSource = read("src/compile/planner.ts");
const rendererSource = read("src/compile/renderer.ts");

const checks: Array<[boolean, string]> = [
  [plannerPrompt.includes("replace_section_body"), "planner prompt names replace_section_body"],
  [plannerPrompt.includes("section_id") && plannerPrompt.includes("claim_id") && plannerPrompt.includes("fact_id"), "planner prompt names stable IDs"],
  [plannerSource.includes("replace_section_body"), "planner schema names replace_section_body"],
  [plannerSource.includes("section_jobs") && plannerSource.includes("dropped_facts") && plannerSource.includes("unresolved_conflicts"), "planner schema field names present"],
  [rendererPrompt.includes("Additional Information"), "renderer prompt forbids Additional Information"],
  [rendererPrompt.includes("RendererOutput"), "renderer prompt names RendererOutput"],
  [rendererSource.includes("replacement_paragraphs") && rendererSource.includes("coverage"), "renderer schema field names present"],
];

const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
if (failed.length > 0) {
  throw new Error(`prompt drift check failed: ${failed.join("; ")}`);
}

function read(relPath: string): string {
  return readFileSync(join(root, relPath), "utf-8");
}
