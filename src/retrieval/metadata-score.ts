import type { SearchDocument } from "./corpus.js";

export interface MetadataScoreOptions {
  now?: Date;
  recencyDays?: number;
  recencyBoost?: number;
  archivedFactor?: number;
  supersededFactor?: number;
  activeFactor?: number;
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
const DEFAULT_ARCHIVED_FACTOR = 0.3;
const DEFAULT_SUPERSEDED_FACTOR = 0.5;
const DEFAULT_ACTIVE_FACTOR = 1;
const DEFAULT_CONFIDENCE = 0.7;
const DAY_MS = 24 * 60 * 60 * 1000;

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

  return documents
    .map((document) => {
      const statusFactor = factorForStatus(document.status, {
        activeFactor,
        supersededFactor,
        archivedFactor,
      });
      const confidenceFactor =
        typeof document.confidence === "number" &&
        document.confidence >= 0 &&
        document.confidence <= 1
          ? document.confidence
          : defaultConfidence;
      const recencyFactor =
        isRecent(documentDate(document), now, recencyDays) ? 1 + recencyBoost : 1;
      return {
        path: document.relPath,
        score: statusFactor * confidenceFactor * recencyFactor,
        components: {
          statusFactor,
          confidenceFactor,
          recencyFactor,
        },
      };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function factorForStatus(
  status: string,
  factors: {
    activeFactor: number;
    supersededFactor: number;
    archivedFactor: number;
  },
): number {
  const normalized = status.toLowerCase();
  if (normalized === "archived") return factors.archivedFactor;
  if (normalized === "superseded") return factors.supersededFactor;
  return factors.activeFactor;
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
