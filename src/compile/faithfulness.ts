import type { LLMProvider } from "../llm/types.js";

export interface FaithfulnessFact {
  fact_id: string;
  narrative: string;
}

export interface ClaimSupportResult {
  supported: boolean;
  unsupportedClaims: string[];
}

export interface AssessClaimSupportOptions {
  body: string;
  facts: FaithfulnessFact[];
  llm: LLMProvider;
  /**
   * The page body before this rewrite. Synthesis preserves existing substantive
   * content, so claims carried over from here are already established and must
   * not be flagged just because they are absent from this pass's fact batch.
   */
  priorBody?: string;
}

const FAITHFULNESS_SYSTEM_PROMPT = [
  "You verify that a memory page's prose is supported by its source facts.",
  "Extract atomic factual claims from the PAGE. For each, check whether it is",
  "directly stated or logically entailed by the SOURCE FACTS, or already present in",
  "the PRIOR PAGE (content carried over from the existing record is established — do not flag it).",
  "Return ONLY new claims that are NOT supported (invented, embellished, or contradicted).",
  "Generic framing sentences with no concrete claim are supported by default.",
  "Be strict: a named technology, status, or metric absent from BOTH the facts and the prior page is unsupported.",
].join(" ");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    unsupported_claims: { type: "array", items: { type: "string" } },
  },
  required: ["unsupported_claims"],
} as const;

export async function assessClaimSupport(opts: AssessClaimSupportOptions): Promise<ClaimSupportResult> {
  const factsBlock = opts.facts.length > 0
    ? opts.facts.map((f) => `- (${f.fact_id}) ${f.narrative}`).join("\n")
    : "(no source facts)";
  const priorBlock = opts.priorBody && opts.priorBody.trim().length > 0
    ? `\n\nPRIOR PAGE (already established — claims here are supported):\n${opts.priorBody}`
    : "";
  const response = await opts.llm.chat({
    messages: [
      { role: "system", content: FAITHFULNESS_SYSTEM_PROMPT },
      { role: "user", content: `SOURCE FACTS:\n${factsBlock}${priorBlock}\n\nPAGE:\n${opts.body}` },
    ],
    temperature: 0,
    jsonSchema: { name: "FaithfulnessOutput", schema: SCHEMA, strict: true },
  });
  if (response.finishReason === "length" || response.finishReason === "filter") {
    // A truncated/filtered judge response cannot be trusted. Do NOT fail open —
    // treat the page as unverifiable and stage it for review. (The sibling detect/synth
    // calls treat the same finishReason as a hard error via throwIfTruncatedResponse.)
    return {
      supported: false,
      unsupportedClaims: [`faithfulness check could not be verified (LLM response ${response.finishReason})`],
    };
  }
  let unsupportedClaims: string[] = [];
  try {
    const parsed = JSON.parse(response.content) as { unsupported_claims?: unknown };
    if (Array.isArray(parsed.unsupported_claims)) {
      unsupportedClaims = parsed.unsupported_claims.filter((c): c is string => typeof c === "string");
    }
  } catch {
    // On parse failure, fail open (treat as supported) - never block compile on a flaky judge.
    unsupportedClaims = [];
  }
  return { supported: unsupportedClaims.length === 0, unsupportedClaims };
}
