import type { LLMProvider, LLMTokenUsage } from "../llm/types.js";
import type { ConsolidationFact } from "./filter-noise.js";
import type { SectionJob } from "./planner.js";
import type { Block, Section } from "./parse-pageir.js";

export interface RendererOutput {
  section_id: string;
  replacement_paragraphs?: string[];
  replacement_blocks?: RendererBlock[];
  coverage: Array<{ fact_id: string; paragraph_index?: number; block_index?: number }>;
}

export type RendererBlock =
  | { type: "paragraph"; text: string }
  | { type: "checklist"; items: Array<{ checked: boolean; text: string }> }
  | { type: "list"; ordered: boolean; items: string[] };

export const BASELINE_FORBIDDEN_TERMS = ["Additional Information"] as const;

export const RENDERER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["section_id", "replacement_paragraphs", "replacement_blocks", "coverage"],
  properties: {
    section_id: { type: "string" },
    replacement_paragraphs: {
      type: "array",
      items: { type: "string" },
    },
    coverage: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["fact_id", "paragraph_index"],
            properties: {
              fact_id: { type: "string" },
              paragraph_index: { type: "integer" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["fact_id", "block_index"],
            properties: {
              fact_id: { type: "string" },
              block_index: { type: "integer" },
            },
          },
        ],
      },
    },
    replacement_blocks: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "text"],
            properties: {
              type: { enum: ["paragraph"] },
              text: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "items"],
            properties: {
              type: { enum: ["checklist"] },
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["checked", "text"],
                  properties: {
                    checked: { type: "boolean" },
                    text: { type: "string" },
                  },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "ordered", "items"],
            properties: {
              type: { enum: ["list"] },
              ordered: { type: "boolean" },
              items: { type: "array", items: { type: "string" } },
            },
          },
        ],
      },
    },
  },
};

const RENDERER_SYSTEM_PROMPT = [
  "You are Memory Fort's section renderer.",
  "You rewrite exactly one existing section body.",
  "You do not write a page.",
  "You do not write headings.",
  "You do not write Markdown bullet-list text; use replacement_blocks for checklist or list sections.",
  "You do not include an appendix, changelog, or \"Additional Information\".",
  "You must remove claims listed in remove_claims.",
  "You must integrate accepted section_claims as prose.",
  "You must preserve still-valid context from current_section when it does not conflict.",
  "For checklist sections, preserve existing item order, do not remove existing items, and append any new items at the end.",
  "BAD output rejected by validator: {\"replacement_paragraphs\":[\"Additional Information: The pipeline executed on 2026-06-01.\"]}.",
  "GOOD output: {\"replacement_paragraphs\":[\"Phase 3 retrieval shipped on 2026-05-31. The live path combines BM25 lexical search with Voyage embeddings, merges with RRF, and runs a reranker before consolidation. The previous planned-state wording is obsolete.\"],\"replacement_blocks\":[],\"coverage\":[{\"fact_id\":\"f_phase3_shipped\",\"paragraph_index\":0}]}.",
  "Checklist example output: {\"replacement_paragraphs\":[],\"replacement_blocks\":[{\"type\":\"checklist\",\"items\":[{\"checked\":true,\"text\":\"Phase 1 shipped\"},{\"checked\":true,\"text\":\"Phase 3 retrieval - shipped (BM25+Voyage+RRF+rerank, 2026-05-31)\"}]}],\"coverage\":[{\"fact_id\":\"f_phase3_shipped\",\"block_index\":0}]}",
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
    "current_blocks:",
    JSON.stringify(section.body_blocks, null, 2),
    "",
    "current_checklist_items:",
    ...section.body_blocks
      .filter((block): block is Extract<Block, { type: "checklist" }> => block.type === "checklist")
      .flatMap((block) => block.items.map((item) => `[${item.checked ? "x" : " "}] ${item.text}`)),
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
    ...baselineForbiddenTerms(job.forbidden_terms),
  ].join("\n");
}

function parseRendererOutput(content: string): RendererOutput {
  const parsed = JSON.parse(extractJsonObject(content));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("renderer output must be an object");
  }
  const record = parsed as RendererOutput;
  if (
    typeof record.section_id !== "string" ||
    !Array.isArray(record.coverage) ||
    (!Array.isArray(record.replacement_paragraphs) && !Array.isArray(record.replacement_blocks))
  ) {
    throw new Error("renderer output missing required fields");
  }
  return record;
}

export function rendererOutputToBlocks(output: RendererOutput): Block[] {
  if (Array.isArray(output.replacement_blocks)) {
    return output.replacement_blocks
      .map(rendererBlockToPageBlock)
      .filter((block): block is Block => block !== null);
  }
  return (output.replacement_paragraphs ?? [])
    .map((paragraph) => ({ type: "paragraph" as const, text: paragraph.trim() }))
    .filter((block) => block.text.length > 0);
}

export function baselineForbiddenTerms(terms: string[]): string[] {
  return Array.from(new Set([...terms, ...BASELINE_FORBIDDEN_TERMS]));
}

function rendererBlockToPageBlock(block: RendererBlock): Block | null {
  if (block.type === "paragraph") {
    const text = block.text.trim();
    return text ? { type: "paragraph", text } : null;
  }
  if (block.type === "checklist") {
    const items = block.items
      .map((item) => ({ checked: Boolean(item.checked), text: item.text.trim() }))
      .filter((item) => item.text.length > 0);
    return items.length > 0 ? { type: "checklist", items } : null;
  }
  if (block.type === "list") {
    const items = block.items.map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? { type: "list", ordered: Boolean(block.ordered), items } : null;
  }
  return null;
}

function extractJsonObject(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/m.exec(content)?.[1]?.trim();
  if (fenced) return fenced;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("renderer returned no JSON object");
  return content.slice(start, end + 1);
}
