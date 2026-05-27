import { describe, expect, it } from "vitest";
import {
  getConfidenceScore,
  getLifecycle,
  getValidationState,
} from "../../src/storage/confidence.js";

describe("confidence helpers", () => {
  it("returns scalar confidence as-is", () => {
    expect(getConfidenceScore(0.7)).toBe(0.7);
  });

  it("uses extraction from vector confidence", () => {
    expect(getConfidenceScore({ extraction: 0.85 })).toBe(0.85);
  });

  it("averages present numeric vector fields when extraction is absent", () => {
    expect(getConfidenceScore({ source: 0.9 })).toBe(0.9);
  });

  it("uses the provided default for missing confidence", () => {
    expect(getConfidenceScore(undefined, 0.5)).toBe(0.5);
  });

  it("clamps scalar confidence above one", () => {
    expect(getConfidenceScore(1.5)).toBe(1);
  });

  it("returns validation state from vector confidence", () => {
    expect(getValidationState({ validation: "user" })).toBe("user");
  });

  it("defaults scalar validation state to unvalidated", () => {
    expect(getValidationState(0.8)).toBe("unvalidated");
  });

  it("defaults raw paths to observed lifecycle", () => {
    expect(getLifecycle({}, "raw/2026-05-26/codex-foo.md")).toBe("observed");
  });

  it("defaults confident wiki pages to canonical lifecycle", () => {
    expect(getLifecycle({ confidence: 0.8 }, "wiki/decisions/foo.md")).toBe(
      "canonical",
    );
  });

  it("defaults low-confidence wiki pages to proposed lifecycle", () => {
    expect(getLifecycle({ confidence: 0.3 }, "wiki/lessons/bar.md")).toBe(
      "proposed",
    );
  });
});
