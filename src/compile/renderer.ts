import type { LLMProvider, LLMTokenUsage } from "../llm/types.js";
import type { ConsolidationFact } from "./filter-noise.js";
import type { SectionJob } from "./planner.js";
import type { Section } from "./parse-pageir.js";

export interface RendererOutput {
  section_id: string;
  replacement_paragraphs: string[];
  coverage: Array<{ fact_id: string; paragraph_index: number }>;
}

export const RENDERER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["section_id", "replacement_paragraphs", "coverage"],
  properties: {
    section_id: { type: "string" },
    replacement_paragraphs: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: { type: "string", minLength: 80, maxLength: 900 },
    },
    coverage: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fact_id", "paragraph_index"],
        properties: {
          fact_id: { type: "string" },
          paragraph_index: { type: "integer" },
        },
      },
    },
  },
};

const RENDERER_SYSTEM_PROMPT = [
  "You are Memory Fort's section renderer.",
  "You rewrite exactly one existing section body.",
  "You do not write a page.",
  "You do not write headings.",
  "You do not write bullet lists.",
  "You do not include an appendix, changelog, or \"Additional Information\".",
  "You must remove claims listed in remove_claims.",
  "You must integrate accepted section_claims as prose.",
  "You must preserve still-valid context from current_section when it does not conflict.",
  "Return JSON matching RendererOutput exactly.",
].join("\n");

export async function renderSectionPatch(opts: {
  llm: LLMProvider;
  section: Section;
  job: SectionJob;
  facts: ConsolidationFact[];
  timeoutMs?: number;
}): Promise<{ output: RendererOutput; tokensUsed?: LLMTokenUsage }> {
  const response = await opts.llm.chat({
    messages: [
      { role: "system", content: RENDERER_SYSTEM_PROMPT },
      { role: "user", content: buildRendererInput(opts.section, opts.job, opts.facts) },
    ],
    temperature: 0.2,
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    jsonSchema: {
      name: "RendererOutput",
      strict: true,
      schema: RENDERER_SCHEMA,
    },
  });
  const output = parseRendererOutput(response.content);
  if (output.section_id !== opts.section.section_id) {
    throw new Error("renderer returned wrong section_id");
  }
  return { output, tokensUsed: response.tokensUsed };
}

function buildRendererInput(section: Section, job: SectionJob, facts: ConsolidationFact[]): string {
  const acceptedFacts = facts.filter((fact) => job.accepted_fact_ids.includes(fact.fact_id));
  const removeClaims = section.claims.filter((claim) => job.remove_claim_ids.includes(claim.claim_id));
  return [
    `section_id=${section.section_id}`,
    `heading=${section.heading}`,
    "",
    "current_body:",
    section.body_markdown,
    "",
    "remove_claims:",
    ...removeClaims.map((claim) => `claim_id=${claim.claim_id} text=${claim.text}`),
    "",
    "accepted_facts:",
    ...acceptedFacts.map((fact) => `fact_id=${fact.fact_id} observed_at=${fact.fact.observedAt} text=${fact.text}`),
    "",
    "required_terms:",
    ...job.required_terms,
    "",
    "forbidden_terms:",
    ...job.forbidden_terms,
  ].join("\n");
}

function parseRendererOutput(content: string): RendererOutput {
  const parsed = JSON.parse(extractJsonObject(content));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("renderer output must be an object");
  }
  const record = parsed as RendererOutput;
  if (typeof record.section_id !== "string" || !Array.isArray(record.replacement_paragraphs) || !Array.isArray(record.coverage)) {
    throw new Error("renderer output missing required fields");
  }
  return record;
}

function extractJsonObject(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/m.exec(content)?.[1]?.trim();
  if (fenced) return fenced;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("renderer returned no JSON object");
  return content.slice(start, end + 1);
}
