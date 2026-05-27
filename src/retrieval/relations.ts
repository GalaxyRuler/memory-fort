export interface RelationEdgeSource {
  agent?: string;
  session_id?: string;
  captured_at?: string;
}

export interface RelationEdge {
  target: string;
  confidence?: number;
  valid_from?: string;
  valid_to?: string | null;
  superseded_by?: string;
  source?: RelationEdgeSource;
  _extra?: Record<string, unknown>;
}

export type RelationMap = Record<string, RelationEdge[]>;

const KNOWN_EDGE_FIELDS = new Set([
  "target",
  "confidence",
  "valid_from",
  "valid_to",
  "superseded_by",
  "source",
]);

export function readRelations(value: unknown, sourcePath = "<unknown>"): RelationMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const relations: RelationMap = {};
  for (const [key, targets] of Object.entries(value)) {
    if (!Array.isArray(targets)) continue;
    const edges = targets.flatMap((entry, index) => {
      const parsed = readRelationEntry(entry);
      if (parsed) return [parsed];
      console.warn(`Dropped malformed relation entry in ${sourcePath} at relations.${key}[${index}]`);
      return [];
    });
    relations[key] = edges;
  }
  return relations;
}

function readRelationEntry(entry: unknown): RelationEdge | null {
  if (typeof entry === "string") {
    return entry.trim().length > 0 ? { target: entry } : null;
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }

  const record = entry as Record<string, unknown>;
  if (typeof record["target"] !== "string" || record["target"].trim().length === 0) {
    return null;
  }

  const edge: RelationEdge = { target: record["target"] };
  if (typeof record["confidence"] === "number" && Number.isFinite(record["confidence"])) {
    edge.confidence = record["confidence"];
  }
  if (typeof record["valid_from"] === "string") {
    edge.valid_from = record["valid_from"];
  }
  if (typeof record["valid_to"] === "string" || record["valid_to"] === null) {
    edge.valid_to = record["valid_to"];
  }
  if (typeof record["superseded_by"] === "string") {
    edge.superseded_by = record["superseded_by"];
  }
  const source = readRelationSource(record["source"]);
  if (source) edge.source = source;

  const extra = Object.fromEntries(
    Object.entries(record).filter(([key]) => !KNOWN_EDGE_FIELDS.has(key)),
  );
  if (Object.keys(extra).length > 0) edge._extra = extra;
  return edge;
}

function readRelationSource(value: unknown): RelationEdgeSource | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const source: RelationEdgeSource = {};
  if (typeof record["agent"] === "string") source.agent = record["agent"];
  if (typeof record["session_id"] === "string") source.session_id = record["session_id"];
  if (typeof record["captured_at"] === "string") source.captured_at = record["captured_at"];
  return Object.keys(source).length > 0 ? source : undefined;
}
