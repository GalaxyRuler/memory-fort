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
  sourceFactCount: number;
  derivedFromCount: number;
  tier: ProvenanceTier;
}

interface ProvenanceDoc {
  relPath: string;
  kind: "wiki" | "raw" | "crystal";
  confidenceFull?: unknown;
  rawFrontmatter?: Record<string, unknown> | null;
  relations?: { derived_from?: Array<{ target: string }> } | Record<string, unknown>;
}

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
): Provenance {
  const confidence = coerceConfidence(doc.confidenceFull);
  const sourceFactCount = countArray((doc.rawFrontmatter ?? {})["source_facts"]);
  const derivedFrom = (doc.relations as { derived_from?: unknown } | undefined)?.derived_from;
  const derivedFromCount = countArray(derivedFrom);

  let tier: ProvenanceTier = "medium";
  const thin = sourceFactCount <= 1 && derivedFromCount <= 1;
  const weakConfidence = confidence !== null && confidence < 0.5;
  if (doc.kind === "wiki" && (thin || weakConfidence)) {
    tier = "low";
  } else if ((confidence === null || confidence >= 0.9) && sourceFactCount >= 3 && derivedFromCount >= 2) {
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
  };
}
