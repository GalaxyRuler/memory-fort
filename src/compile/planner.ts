import type { LLMProvider, LLMTokenUsage } from "../llm/types.js";
import type { ConsolidationFact } from "./filter-noise.js";
import type { PageIR, Section } from "./parse-pageir.js";

export interface PlannerSectionClaim {
  claim: string;
  source_fact_ids: string[];
}

export interface SectionJob {
  section_id: string;
  operation: "replace_section_body";
  accepted_fact_ids: string[];
  remove_claim_ids: string[];
  required_terms: string[];
  forbidden_terms: string[];
  section_claims: PlannerSectionClaim[];
  claim_reason: "status_change" | "clarification" | "contradiction" | "superseded" | null;
}

export interface PlannerOutput {
  section_jobs: SectionJob[];
  dropped_facts: Array<{
    fact_id: string;
    reason: "workflow_noise" | "stale" | "duplicate" | "low_importance" | "unsupported";
  }>;
  unresolved_conflicts: Array<{
    fact_ids: string[];
    reason: string;
  }>;
}

export interface PlanSectionPatchesOptions {
  llm: LLMProvider;
  page: PageIR;
  facts: ConsolidationFact[];
  droppedFacts?: PlannerOutput["dropped_facts"];
  timeoutMs?: number;
}

export const PLANNER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["section_jobs", "dropped_facts", "unresolved_conflicts"],
  properties: {
    section_jobs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["section_id", "operation", "accepted_fact_ids", "remove_claim_ids", "required_terms", "forbidden_terms", "section_claims", "claim_reason"],
        properties: {
          section_id: { type: "string" },
          operation: { enum: ["replace_section_body"] },
          accepted_fact_ids: { type: "array", items: { type: "string" } },
          remove_claim_ids: { type: "array", items: { type: "string" } },
          required_terms: { type: "array", items: { type: "string" } },
          forbidden_terms: { type: "array", items: { type: "string" } },
          section_claims: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["claim", "source_fact_ids"],
              properties: {
                claim: { type: "string" },
                source_fact_ids: { type: "array", items: { type: "string" } },
              },
            },
          },
          claim_reason: {
            type: ["string", "null"],
            enum: ["status_change", "clarification", "contradiction", "superseded", null],
          },
        },
      },
    },
    dropped_facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fact_id", "reason"],
        properties: {
          fact_id: { type: "string" },
          reason: { enum: ["workflow_noise", "stale", "duplicate", "low_importance", "unsupported"] },
        },
      },
    },
    unresolved_conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fact_ids", "reason"],
        properties: {
          fact_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
      },
    },
  },
};

const PLANNER_SYSTEM_PROMPT = [
  "You are Memory Fort's consolidation planner.",
  "You do not write Markdown.",
  "You do not rewrite the page.",
  "You choose which existing section bodies must be replaced.",
  "Rules:",
  "1. Use only the supplied section_id, claim_id, and fact_id values.",
  "2. The only operation is replace_section_body.",
  "3. There is no append operation.",
  "4. If a new fact contradicts an old claim, include the old claim_id in remove_claim_ids.",
  "5. Drop workflow/process noise even if it appears in facts.",
  "6. If no existing section can receive a fact, put it in unresolved_conflicts. Do not invent a section title.",
  "7. Return JSON matching PlannerOutput exactly.",
].join("\n");

export async function planSectionPatches(opts: PlanSectionPatchesOptions): Promise<{
  output: PlannerOutput;
  tokensUsed?: LLMTokenUsage;
}> {
  const response = await opts.llm.chat({
    messages: [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: buildPlannerInput(opts.page, opts.facts, opts.droppedFacts ?? []) },
    ],
    temperature: 0.2,
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    jsonSchema: {
      name: "PlannerOutput",
      strict: true,
      schema: PLANNER_SCHEMA,
    },
  });
  const output = parsePlannerOutput(response.content);
  validatePlannerOutput(output, opts.page, opts.facts);
  return { output, tokensUsed: response.tokensUsed };
}

function buildPlannerInput(page: PageIR, facts: ConsolidationFact[], droppedFacts: PlannerOutput["dropped_facts"]): string {
  const sections = page.sections.map((section) => [
    `section_id=${section.section_id}`,
    `heading=${section.heading}`,
    `level=${section.level}`,
    `structured=${section.has_structured_blocks}`,
    "claims:",
    ...section.claims.map((claim) => `claim_id=${claim.claim_id} text=${claim.text}`),
  ].join("\n"));
  return [
    `page_title=${page.title}`,
    "",
    "sections:",
    sections.join("\n\n"),
    "",
    "facts:",
    ...facts.map((fact) => `fact_id=${fact.fact_id} observed_at=${fact.fact.observedAt} text=${fact.text}`),
    "",
    "pre_dropped_facts:",
    JSON.stringify(droppedFacts),
  ].join("\n");
}

function parsePlannerOutput(content: string): PlannerOutput {
  const parsed = JSON.parse(extractJsonObject(content));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("planner output must be an object");
  }
  const record = parsed as PlannerOutput;
  if (!Array.isArray(record.section_jobs) || !Array.isArray(record.dropped_facts) || !Array.isArray(record.unresolved_conflicts)) {
    throw new Error("planner output missing required arrays");
  }
  return record;
}

function validatePlannerOutput(output: PlannerOutput, page: PageIR, facts: ConsolidationFact[]): void {
  const sectionIds = new Set(page.sections.map((section) => section.section_id));
  const factIds = new Set(facts.map((fact) => fact.fact_id));
  const claimsBySection = new Map<string, Section["claims"]>(page.sections.map((section) => [section.section_id, section.claims]));
  for (const job of output.section_jobs) {
    if (!sectionIds.has(job.section_id)) throw new Error(`planner referenced unknown section_id ${job.section_id}`);
    if (job.operation !== "replace_section_body") throw new Error("planner emitted unsupported operation");
    for (const factId of job.accepted_fact_ids) {
      if (!factIds.has(factId)) throw new Error(`planner referenced unknown fact_id ${factId}`);
    }
    const claimIds = new Set((claimsBySection.get(job.section_id) ?? []).map((claim) => claim.claim_id));
    for (const claimId of job.remove_claim_ids) {
      if (!claimIds.has(claimId)) throw new Error(`planner referenced unknown claim_id ${claimId}`);
    }
    if (job.remove_claim_ids.length > 0 && !job.claim_reason) {
      throw new Error("planner removals require claim_reason");
    }
  }
}

function extractJsonObject(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/m.exec(content)?.[1]?.trim();
  if (fenced) return fenced;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("planner returned no JSON object");
  return content.slice(start, end + 1);
}
