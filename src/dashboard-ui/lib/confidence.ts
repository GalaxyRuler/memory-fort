import type {
  ConfidenceVector,
  Frontmatter,
  LifecycleStage,
  ValidationState,
} from "../../storage/frontmatter.js";

const KNOWN_VALIDATION_STATES = [
  "unvalidated",
  "auto",
  "user",
  "challenged",
  "revoked",
] as const satisfies readonly ValidationState[];

const KNOWN_LIFECYCLE_STAGES = [
  "observed",
  "linked",
  "proposed",
  "consolidated",
  "canonical",
  "stale",
  "disputed",
  "dormant",
  "archived",
] as const satisfies readonly LifecycleStage[];

export function getConfidenceScore(
  confidence: number | ConfidenceVector | undefined,
  defaultScore?: number,
): number {
  if (confidence === undefined) {
    return clampScore(defaultScore ?? 0);
  }

  if (typeof confidence === "number") {
    return clampScore(confidence);
  }

  if (typeof confidence !== "object" || confidence === null) {
    return clampScore(defaultScore ?? 0);
  }

  if (typeof confidence.extraction === "number") {
    return clampScore(confidence.extraction);
  }

  const numericFields = [confidence.source].filter(isFiniteNumber);
  if (numericFields.length === 0) {
    return clampScore(defaultScore ?? 0);
  }

  const total = numericFields.reduce((sum, value) => sum + value, 0);
  return clampScore(total / numericFields.length);
}

export function getValidationState(
  confidence: number | ConfidenceVector | undefined,
): ValidationState {
  if (
    confidence &&
    typeof confidence === "object" &&
    KNOWN_VALIDATION_STATES.includes(confidence.validation as never)
  ) {
    return confidence.validation as ValidationState;
  }

  return "unvalidated";
}

export function getLifecycle(
  frontmatter: Partial<Frontmatter>,
  relPath: string,
): LifecycleStage {
  if (KNOWN_LIFECYCLE_STAGES.includes(frontmatter.lifecycle as never)) {
    return frontmatter.lifecycle as LifecycleStage;
  }

  const normalizedPath = relPath.replace(/\\/g, "/");
  if (normalizedPath.startsWith("raw/")) {
    return "observed";
  }

  if (
    normalizedPath.startsWith("wiki/") &&
    getConfidenceScore(frontmatter.confidence) >= 0.6
  ) {
    return "canonical";
  }

  return "proposed";
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
