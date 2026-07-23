export type ProvenanceTier = "high" | "medium" | "low";

export interface ProvenanceSignal {
  source: string;
  rank: number;
}

export interface Provenance {
  path: string;
  kind: "wiki" | "raw" | "crystal";
  dominantSource: string;
  signals: ProvenanceSignal[];
  confidence: number | null;
  confidenceMetadata?: unknown;
  validation?: string | null;
  sourceFactCount: number | null;
  derivedFromCount: number | null;
  tier: ProvenanceTier | null;
  chunkId?: string | null;
  chunkOrdinal?: number | null;
  byteStart?: number | null;
  byteEnd?: number | null;
  sourceContentHash?: string | null;
  chunkTextHash?: string | null;
  indexGeneration?: number | null;
  indexedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  observedAt?: string | null;
  lexicalRank?: number | null;
  lexicalScore?: number | null;
  vectorRank?: number | null;
  vectorDistance?: number | null;
  appliedScope?: "all" | "wiki" | "raw" | "crystals" | null;
  appliedFilters?: {
    includeArchived: boolean | null;
    asOf: string | null;
    agentId: string | null;
    userId: string | null;
    identityMode: "inclusive" | "strict" | null;
  } | null;
  backend?: "legacy" | "index-lexical" | "index-hybrid" | null;
  rankingProfile?: string | null;
}

interface ProvenanceDoc {
  relPath: string;
  kind: "wiki" | "raw" | "crystal";
  confidenceFull?: unknown;
  rawFrontmatter?: Record<string, unknown> | null;
  relations?: { derived_from?: Array<{ target: string }> } | Record<string, unknown>;
  sourceFactCount?: number | null;
  derivedFromCount?: number | null;
}

export type ProvenanceDetails = Omit<
  Partial<Provenance>,
  "path" | "kind" | "dominantSource" | "signals" | "confidence" | "sourceFactCount" | "derivedFromCount" | "tier"
>;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function coerceConfidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return clamp01(value);
  if (value && typeof value === "object") {
    const vector = value as Record<string, unknown>;
    const extraction = vector["extraction"];
    if (typeof extraction === "number" && Number.isFinite(extraction)) return clamp01(extraction);
    const src = vector["source"];
    if (typeof src === "number" && Number.isFinite(src)) return clamp01(src);
  }
  return null;
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function buildProvenance(
  doc: ProvenanceDoc,
  dominantSource: string,
  signals: ProvenanceSignal[],
  details: ProvenanceDetails = {},
): Provenance {
  const confidence = coerceConfidence(doc.confidenceFull);
  const sourceFactCount = doc.sourceFactCount === undefined
    ? countArray(doc.rawFrontmatter?.["source_facts"])
    : doc.sourceFactCount;
  const derivedFrom = (doc.relations as { derived_from?: unknown } | undefined)?.derived_from;
  const derivedFromCount = doc.derivedFromCount === undefined
    ? countArray(derivedFrom)
    : doc.derivedFromCount;

  let tier: ProvenanceTier | null =
    sourceFactCount === null || derivedFromCount === null ? null : "medium";
  const thin =
    sourceFactCount !== null &&
    derivedFromCount !== null &&
    sourceFactCount <= 1 &&
    derivedFromCount <= 1;
  const weakConfidence = confidence !== null && confidence < 0.5;
  if (doc.kind === "wiki" && (thin || weakConfidence)) {
    tier = "low";
  } else if (
    (confidence === null || confidence >= 0.9) &&
    sourceFactCount !== null &&
    sourceFactCount >= 3 &&
    derivedFromCount !== null &&
    derivedFromCount >= 2
  ) {
    tier = "high";
  }

  return {
    path: doc.relPath,
    kind: doc.kind,
    dominantSource,
    signals: signals.map((s) => ({ ...s })),
    confidence,
    sourceFactCount,
    derivedFromCount,
    tier,
    ...details,
  };
}
