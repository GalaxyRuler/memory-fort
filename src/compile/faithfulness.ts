import type { LLMProvider } from "../llm/types.js";

export interface FaithfulnessFact {
  fact_id: string;
  narrative: string;
}

export type ClaimSupportOutcome = "supported" | "unsupported" | "unverifiable";

/** A verdict is never a boolean: judge failures must be visible to callers. */
export interface ClaimSupportResult {
  outcome: ClaimSupportOutcome;
  unsupportedClaims: string[];
  /** Present for `unverifiable` so a proposal explains why it was staged. */
  reason?: string;
  /** Bounded judge calls, including the one syntax-repair retry when needed. */
  llmCalls: number;
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
    ? opts.facts.map((fact) => `- (${fact.fact_id}) ${fact.narrative}`).join("\n")
    : "(no source facts)";
  const priorBlock = opts.priorBody && opts.priorBody.trim().length > 0
    ? `\n\nPRIOR PAGE (already established — claims here are supported):\n${opts.priorBody}`
    : "";
  const request = {
    messages: [
      { role: "system" as const, content: FAITHFULNESS_SYSTEM_PROMPT },
      { role: "user" as const, content: `SOURCE FACTS:\n${factsBlock}${priorBlock}\n\nPAGE:\n${opts.body}` },
    ],
    temperature: 0,
    jsonSchema: { name: "FaithfulnessOutput", schema: SCHEMA, strict: true },
  };

  let response;
  try {
    response = await opts.llm.chat(request);
  } catch (error) {
    return unverifiable(`faithfulness judge failed: ${errorMessage(error)}`, 1);
  }
  const first = parseJudgeResponse(response);
  if (first.kind === "valid") return verdict(first.unsupportedClaims, 1);
  if (first.kind === "invalid") return unverifiable(first.reason, 1);

  // Only malformed JSON gets one repair retry. Schema failures are not repaired:
  // accepting them would turn missing/wrong fields into a silent pass.
  let repaired;
  try {
    repaired = await opts.llm.chat({
      ...request,
      messages: [
        ...request.messages,
        { role: "assistant", content: response.content },
        {
          role: "user",
          content: "The prior reply was malformed JSON. Return exactly one JSON object matching the requested schema, with no markdown or commentary.",
        },
      ],
    });
  } catch (error) {
    return unverifiable(`faithfulness judge repair failed: ${errorMessage(error)}`, 2);
  }
  const second = parseJudgeResponse(repaired);
  if (second.kind === "valid") return verdict(second.unsupportedClaims, 2);
  return unverifiable(
    second.kind === "malformed"
      ? "faithfulness judge remained malformed after one repair retry"
      : second.reason,
    2,
  );
}

type ParsedJudgeResponse =
  | { kind: "valid"; unsupportedClaims: string[] }
  | { kind: "malformed" }
  | { kind: "invalid"; reason: string };

function parseJudgeResponse(response: { content: string; finishReason: string }): ParsedJudgeResponse {
  if (response.finishReason !== "stop") {
    return { kind: "invalid", reason: `faithfulness judge could not be verified (finishReason=${response.finishReason})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.content);
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "faithfulness judge returned a non-object response" };
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "unsupported_claims") {
    return { kind: "invalid", reason: "faithfulness judge returned an invalid response schema" };
  }
  const claims = record.unsupported_claims;
  if (!Array.isArray(claims) || claims.some((claim) => typeof claim !== "string")) {
    return { kind: "invalid", reason: "faithfulness judge returned invalid unsupported_claims" };
  }
  return { kind: "valid", unsupportedClaims: claims };
}

function verdict(unsupportedClaims: string[], llmCalls: number): ClaimSupportResult {
  return unsupportedClaims.length === 0
    ? { outcome: "supported", unsupportedClaims, llmCalls }
    : { outcome: "unsupported", unsupportedClaims, llmCalls };
}

function unverifiable(reason: string, llmCalls: number): ClaimSupportResult {
  return { outcome: "unverifiable", unsupportedClaims: [], reason, llmCalls };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
