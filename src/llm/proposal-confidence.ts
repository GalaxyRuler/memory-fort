export const MIN_OBS_COUNT = 5;
export const MIN_DISTINCT_SESSIONS = 2;

export interface ConfidenceInput {
  grounding: {
    strippedReferenceCount: number;
    prosePathLeaksCount: number;
    commandsStripped?: string[];
  };
  cluster: {
    observationCount: number;
    distinctSessions: number;
  };
}

export interface ProposalConfidence {
  level: "high" | "low";
  reasons: string[];
}

export function scoreProposalConfidence(input: ConfidenceInput): ProposalConfidence {
  const reasons: string[] = [];
  const commandStripCount = input.grounding.commandsStripped?.length ?? 0;

  if (input.grounding.strippedReferenceCount !== 0) {
    reasons.push(`strippedReferenceCount=${input.grounding.strippedReferenceCount}`);
  }
  if (input.grounding.prosePathLeaksCount !== 0) {
    reasons.push(`prosePathLeaksCount=${input.grounding.prosePathLeaksCount}`);
  }
  if (commandStripCount !== 0) {
    reasons.push(`commandsStripped=${commandStripCount}`);
  }
  if (input.cluster.observationCount < MIN_OBS_COUNT) {
    reasons.push(`observationCount=${input.cluster.observationCount} below threshold ${MIN_OBS_COUNT}`);
  }
  if (input.cluster.distinctSessions < MIN_DISTINCT_SESSIONS) {
    reasons.push(`distinctSessions=${input.cluster.distinctSessions} below threshold ${MIN_DISTINCT_SESSIONS}`);
  }

  return reasons.length === 0
    ? { level: "high", reasons: ["all signals clean"] }
    : { level: "low", reasons };
}
