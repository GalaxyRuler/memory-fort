import { describe, expect, it } from "vitest";
import {
  MIN_DISTINCT_SESSIONS,
  MIN_OBS_COUNT,
  scoreProposalConfidence,
} from "../../src/llm/proposal-confidence.js";

describe("scoreProposalConfidence", () => {
  it("marks clean grounded multi-session clusters as high confidence", () => {
    expect(scoreProposalConfidence({
      grounding: {
        strippedReferenceCount: 0,
        prosePathLeaksCount: 0,
        commandsStripped: [],
      },
      cluster: {
        observationCount: MIN_OBS_COUNT,
        distinctSessions: MIN_DISTINCT_SESSIONS,
      },
    })).toEqual({
      level: "high",
      reasons: ["all signals clean"],
    });
  });

  it.each([
    ["stripped references", { strippedReferenceCount: 1, prosePathLeaksCount: 0, commandsStripped: [] }, "strippedReferenceCount=1"],
    ["prose path leaks", { strippedReferenceCount: 0, prosePathLeaksCount: 2, commandsStripped: [] }, "prosePathLeaksCount=2"],
    ["stripped commands", { strippedReferenceCount: 0, prosePathLeaksCount: 0, commandsStripped: ["run-automation"] }, "commandsStripped=1"],
  ])("marks %s as low confidence", (_name, grounding, reason) => {
    expect(scoreProposalConfidence({
      grounding,
      cluster: { observationCount: MIN_OBS_COUNT, distinctSessions: MIN_DISTINCT_SESSIONS },
    })).toEqual({
      level: "low",
      reasons: [reason],
    });
  });

  it("enforces observation and distinct-session thresholds", () => {
    expect(scoreProposalConfidence({
      grounding: { strippedReferenceCount: 0, prosePathLeaksCount: 0 },
      cluster: { observationCount: MIN_OBS_COUNT - 1, distinctSessions: MIN_DISTINCT_SESSIONS - 1 },
    })).toEqual({
      level: "low",
      reasons: [
        `observationCount=${MIN_OBS_COUNT - 1} below threshold ${MIN_OBS_COUNT}`,
        `distinctSessions=${MIN_DISTINCT_SESSIONS - 1} below threshold ${MIN_DISTINCT_SESSIONS}`,
      ],
    });
  });
});
