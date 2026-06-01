import { NOISE_PATTERNS } from "./filter-noise.js";
import type { SectionJob } from "./planner.js";
import type { Block, Section } from "./parse-pageir.js";
import { baselineForbiddenTerms, rendererOutputToBlocks, type RendererOutput } from "./renderer.js";

export function validateRender(render: RendererOutput, job: SectionJob, section: Section): void {
  if (render.section_id !== section.section_id) {
    throw new Error("render section_id mismatch");
  }
  const blocks = rendererOutputToBlocks(render);
  if (blocks.length === 0) {
    throw new Error("render emitted no replacement blocks");
  }
  const text = blockText(blocks);
  rejectIf(/^#{1,6}\s/m.test(text), "render emitted heading");
  if (!Array.isArray(render.replacement_blocks)) {
    rejectIf(/^\s*([-*+]|\d+\.)\s+/m.test(text), "render emitted list");
  }
  rejectIf(/```/.test(text), "render emitted code fence");
  rejectIf(/^\s*>/m.test(text), "render emitted blockquote");
  rejectIf(/^\s*\|.*\|\s*$/m.test(text), "render emitted table");
  rejectIf(/Additional Information/i.test(text), "render emitted Additional Information");
  rejectIf(baselineForbiddenTerms(job.forbidden_terms).some((term) => text.includes(term)), "render emitted forbidden term");
  rejectIf(NOISE_PATTERNS.some((pattern) => pattern.test(text)), "render emitted workflow noise");
  for (const term of job.required_terms) {
    rejectIf(!text.toLowerCase().includes(term.toLowerCase()), `render missing required term: ${term}`);
  }
  for (const claimId of job.remove_claim_ids) {
    const old = section.claims.find((claim) => claim.claim_id === claimId)?.text;
    rejectIf(Boolean(old && normalize(text).includes(normalize(old))), "stale claim still present");
  }
  if (Array.isArray(render.replacement_blocks)) {
    validateReplacementBlocks(blocks, render, section);
  }
}

function validateReplacementBlocks(blocks: Block[], render: RendererOutput, section: Section): void {
  blocks.forEach((block, blockIndex) => {
    if (block.type === "paragraph") {
      rejectIf(/^\s*([-*+]|\d+\.)\s+/m.test(block.text), "paragraph block emitted list");
    }
    if (block.type === "checklist") {
      validateChecklistBlock(block, blockIndex, render, section);
    }
    if (block.type === "list") {
      rejectIf(block.items.some((item) => NOISE_PATTERNS.some((pattern) => pattern.test(item))), "list emitted workflow noise");
    }
  });
}

function validateChecklistBlock(
  block: Extract<Block, { type: "checklist" }>,
  blockIndex: number,
  render: RendererOutput,
  section: Section,
): void {
  const currentChecklist = section.body_blocks.find((candidate): candidate is Extract<Block, { type: "checklist" }> =>
    candidate.type === "checklist"
  );
  if (!currentChecklist) return;
  rejectIf(block.items.length < currentChecklist.items.length, "checklist removed existing items");
  currentChecklist.items.forEach((item, index) => {
    const replacement = block.items[index];
    rejectIf(
      !replacement || checklistItemKey(replacement.text) !== checklistItemKey(item.text),
      "checklist reordered existing items",
    );
  });
  const hasCoverage = render.coverage.some((coverage) => coverage.block_index === blockIndex && typeof coverage.fact_id === "string");
  for (const item of block.items.slice(currentChecklist.items.length)) {
    rejectIf(NOISE_PATTERNS.some((pattern) => pattern.test(item.text)), "checklist emitted workflow noise");
    rejectIf(!hasCoverage, "checklist appended item missing coverage");
  }
}

function blockText(blocks: Block[]): string {
  return blocks.map((block) => {
    if (block.type === "paragraph") return block.text;
    if (block.type === "checklist") return block.items.map((item) => item.text).join("\n");
    if (block.type === "list") return block.items.join("\n");
    return block.markdown;
  }).join("\n\n");
}

function rejectIf(condition: boolean, reason: string): void {
  if (condition) throw new Error(reason);
}

function normalize(value: string): string {
  return value.replace(/[`*_~[\]()#>:.-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function checklistItemKey(value: string): string {
  const phase = /\bphase\s+\d+(?:\.\d+)*\b/i.exec(value)?.[0];
  if (phase) return normalize(phase);
  return normalize(value)
    .split(" ")
    .filter((token) => !["planned", "ship", "shipped", "shipping", "done", "todo", "validated", "complete", "completed"].includes(token))
    .slice(0, 4)
    .join(" ");
}
