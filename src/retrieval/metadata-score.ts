import type { SearchDocument } from "./corpus.js";
import { getConfidenceScore, getValidationState } from "../storage/confidence.js";
import type { LifecycleStage, ValidationState } from "../storage/frontmatter.js";

export interface MetadataScoreOptions {
  now?: Date;
  recencyDays?: number;
  recencyBoost?: number;
  archivedFactor?: number;
  supersededFactor?: number;
  activeFactor?: number;
  canonicalFactor?: number;
  consolidatedFactor?: number;
  proposedFactor?: number;
  observedFactor?: number;
  linkedFactor?: number;
  staleFactor?: number;
  disputedFactor?: number;
  dormantFactor?: number;
  userValidationFactor?: number;
  autoValidationFactor?: number;
  challengedValidationFactor?: number;
  revokedValidationFactor?: number;
  defaultConfidence?: number;
}

export interface MetadataScored {
  path: string;
  score: number;
  components: {
    statusFactor: number;
    confidenceFactor: number;
    recencyFactor: number;
  };
}

const DEFAULT_RECENCY_DAYS = 30;
const DEFAULT_RECENCY_BOOST = 0.1;
const DEFAULT_ARCHIVED_FACTOR = 0;
const DEFAULT_SUPERSEDED_FACTOR = 0.1;
const DEFAULT_ACTIVE_FACTOR = 1;
const DEFAULT_CANONICAL_FACTOR = 1;
const DEFAULT_CONSOLIDATED_FACTOR = 0.9;
const DEFAULT_PROPOSED_FACTOR = 0.7;
const DEFAULT_OBSERVED_FACTOR = 0.85;
const DEFAULT_LINKED_FACTOR = 0.85;
const DEFAULT_STALE_FACTOR = 0.5;
const DEFAULT_DISPUTED_FACTOR = 0.3;
const DEFAULT_DORMANT_FACTOR = 0.4;
const DEFAULT_USER_VALIDATION_FACTOR = 1.2;
const DEFAULT_AUTO_VALIDATION_FACTOR = 1.05;
const DEFAULT_CHALLENGED_VALIDATION_FACTOR = 0.4;
const DEFAULT_REVOKED_VALIDATION_FACTOR = 0;
const DEFAULT_CONFIDENCE = 0.7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface StatusLifecycleFactors {
  activeFactor: number;
  supersededFactor: number;
  archivedFactor: number;
  canonicalFactor: number;
  consolidatedFactor: number;
  proposedFactor: number;
  observedFactor: number;
  linkedFactor: number;
  staleFactor: number;
  disputedFactor: number;
  dormantFactor: number;
  userValidationFactor: number;
  autoValidationFactor: number;
  challengedValidationFactor: number;
  revokedValidationFactor: number;
}

export function scoreByMetadata(
  documents: SearchDocument[],
  opts: MetadataScoreOptions = {},
): MetadataScored[] {
  const now = opts.now ?? new Date();
  const recencyDays = opts.recencyDays ?? DEFAULT_RECENCY_DAYS;
  const recencyBoost = opts.recencyBoost ?? DEFAULT_RECENCY_BOOST;
  const archivedFactor = opts.archivedFactor ?? DEFAULT_ARCHIVED_FACTOR;
  const supersededFactor = opts.supersededFactor ?? DEFAULT_SUPERSEDED_FACTOR;
  const activeFactor = opts.activeFactor ?? DEFAULT_ACTIVE_FACTOR;
  const defaultConfidence = opts.defaultConfidence ?? DEFAULT_CONFIDENCE;
  const factors: StatusLifecycleFactors = {
    activeFactor,
    supersededFactor,
    archivedFactor,
    canonicalFactor: opts.canonicalFactor ?? DEFAULT_CANONICAL_FACTOR,
    consolidatedFactor: opts.consolidatedFactor ?? DEFAULT_CONSOLIDATED_FACTOR,
    proposedFactor: opts.proposedFactor ?? DEFAULT_PROPOSED_FACTOR,
    observedFactor: opts.observedFactor ?? DEFAULT_OBSERVED_FACTOR,
    linkedFactor: opts.linkedFactor ?? DEFAULT_LINKED_FACTOR,
    staleFactor: opts.staleFactor ?? DEFAULT_STALE_FACTOR,
    disputedFactor: opts.disputedFactor ?? DEFAULT_DISPUTED_FACTOR,
    dormantFactor: opts.dormantFactor ?? DEFAULT_DORMANT_FACTOR,
    userValidationFactor: opts.userValidationFactor ?? DEFAULT_USER_VALIDATION_FACTOR,
    autoValidationFactor: opts.autoValidationFactor ?? DEFAULT_AUTO_VALIDATION_FACTOR,
    challengedValidationFactor:
      opts.challengedValidationFactor ?? DEFAULT_CHALLENGED_VALIDATION_FACTOR,
    revokedValidationFactor: opts.revokedValidationFactor ?? DEFAULT_REVOKED_VALIDATION_FACTOR,
  };

  return documents
    .map((document) => {
      const statusFactor = factorForStatusAndLifecycle(
        document.status,
        document.lifecycle ?? "canonical",
        getValidationState(document.confidenceFull ?? undefined),
        factors,
      );
      const confidenceFactor = getConfidenceScore(
        document.confidenceFull ?? document.confidence ?? undefined,
        defaultConfidence,
      );
      const recencyFactor =
        isRecent(documentDate(document), now, recencyDays) ? 1 + recencyBoost : 1;
      const score = Math.min(1, statusFactor * confidenceFactor * recencyFactor);
      return {
        path: document.relPath,
        score,
        components: {
          statusFactor,
          confidenceFactor,
          recencyFactor,
        },
      };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export function factorForStatusAndLifecycle(
  status: string,
  lifecycle: LifecycleStage,
  validation: ValidationState,
  factors: StatusLifecycleFactors,
): number {
  const normalized = status.toLowerCase();
  let factor = factors.activeFactor;
  if (normalized === "archived") factor *= factors.archivedFactor;
  else if (normalized === "superseded") factor *= factors.supersededFactor;

  factor *= lifecycleFactor(lifecycle, factors);
  factor *= validationFactor(validation, factors);
  return factor;
}

function lifecycleFactor(
  lifecycle: LifecycleStage,
  factors: StatusLifecycleFactors,
): number {
  switch (lifecycle) {
    case "canonical":
      return factors.canonicalFactor;
    case "consolidated":
      return factors.consolidatedFactor;
    case "proposed":
      return factors.proposedFactor;
    case "observed":
      return factors.observedFactor;
    case "linked":
      return factors.linkedFactor;
    case "stale":
      return factors.staleFactor;
    case "disputed":
      return factors.disputedFactor;
    case "dormant":
      return factors.dormantFactor;
    case "archived":
      return factors.archivedFactor;
  }
}

function validationFactor(
  validation: ValidationState,
  factors: StatusLifecycleFactors,
): number {
  switch (validation) {
    case "user":
      return factors.userValidationFactor;
    case "auto":
      return factors.autoValidationFactor;
    case "challenged":
      return factors.challengedValidationFactor;
    case "revoked":
      return factors.revokedValidationFactor;
    case "unvalidated":
      return 1;
  }
}

function documentDate(document: SearchDocument): Date | null {
  const referenceTime = document.updated
    ? Date.parse(document.updated)
    : Date.parse(document.mtime);
  return Number.isNaN(referenceTime) ? null : new Date(referenceTime);
}

function isRecent(date: Date | null, now: Date, recencyDays: number): boolean {
  if (!date) return false;
  const ageMs = now.getTime() - date.getTime();
  return ageMs >= 0 && ageMs <= recencyDays * DAY_MS;
}
