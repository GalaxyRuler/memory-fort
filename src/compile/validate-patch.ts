import { NOISE_PATTERNS } from "./filter-noise.js";
import type { SectionJob } from "./planner.js";
import type { Section } from "./parse-pageir.js";
import type { RendererOutput } from "./renderer.js";

export function validateRender(render: RendererOutput, job: SectionJob, section: Section): void {
  if (render.section_id !== section.section_id) {
    throw new Error("render section_id mismatch");
  }
  if (render.replacement_paragraphs.length === 0) {
    throw new Error("render emitted no replacement paragraphs");
  }
  const text = render.replacement_paragraphs.join("\n\n");
  rejectIf(/^#{1,6}\s/m.test(text), "render emitted heading");
  rejectIf(/^\s*([-*+]|\d+\.)\s+/m.test(text), "render emitted list");
  rejectIf(/```/.test(text), "render emitted code fence");
  rejectIf(/^\s*>/m.test(text), "render emitted blockquote");
  rejectIf(/^\s*\|.*\|\s*$/m.test(text), "render emitted table");
  rejectIf(/Additional Information/i.test(text), "render emitted Additional Information");
  rejectIf(job.forbidden_terms.some((term) => text.includes(term)), "render emitted forbidden term");
  rejectIf(NOISE_PATTERNS.some((pattern) => pattern.test(text)), "render emitted workflow noise");
  for (const term of job.required_terms) {
    rejectIf(!text.toLowerCase().includes(term.toLowerCase()), `render missing required term: ${term}`);
  }
  for (const claimId of job.remove_claim_ids) {
    const old = section.claims.find((claim) => claim.claim_id === claimId)?.text;
    rejectIf(Boolean(old && normalize(text).includes(normalize(old))), "stale claim still present");
  }
}

function rejectIf(condition: boolean, reason: string): void {
  if (condition) throw new Error(reason);
}

function normalize(value: string): string {
  return value.replace(/[`*_~[\]()#>:.-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
