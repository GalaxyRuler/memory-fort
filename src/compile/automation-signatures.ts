import { splitTurns } from "./raw-turns.js";

/**
 * Known machine-generated prompt templates. These are platform automation pings
 * (not user-authored work) that carry a cwd/project but no durable knowledge.
 * Adding a new automation source = add an entry here (data, not code).
 * Capture a real sample before adding: the regex must match the verbatim template.
 */
export interface AutomationSignature {
  id: string;
  re: RegExp;
}

export const AUTOMATION_PROMPT_SIGNATURES: AutomationSignature[] = [
  {
    id: "codex-suggestion-generator",
    // Verified against captured Codex suggestion-generator raw sessions.
    re: /Generate 0 to 3 hyperpersonalized suggestions for what this user can do/u,
  },
];

function matchSignature(promptBody: string): string | null {
  for (const sig of AUTOMATION_PROMPT_SIGNATURES) {
    if (sig.re.test(promptBody)) return sig.id;
  }
  return null;
}

/**
 * Returns the automation signature id when EVERY Prompt turn in the session
 * matches a known automation template, else null. A single user-authored Prompt
 * turn disqualifies the session (we never drop sessions with real user intent).
 */
export function detectAutomationKind(text: string): string | null {
  const turns = splitTurns(text);
  const promptTurns = turns.filter((turn) => turn.kind === "Prompt");
  if (promptTurns.length === 0) return null;
  let kind: string | null = null;
  for (const turn of promptTurns) {
    const match = matchSignature(turn.body);
    if (match === null) return null;
    kind = match;
  }
  return kind;
}
