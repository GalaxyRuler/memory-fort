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
export type SerializedRelationEdge = string | Record<string, unknown>;
export type SerializedRelationMap = Record<string, SerializedRelationEdge[]>;

const SCHEMA_RELATION_ORDER = [
  "mentions",
  "supports",
  "contradicts",
  "supersedes",
  "derived_from",
  "uses",
  "depends_on",
  "caused_by",
  "fixed_by",
  "mentioned_in",
  "linked",
];

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

export function writeRelations(relations: RelationMap): SerializedRelationMap {
  const result: SerializedRelationMap = {};
  for (const key of orderedRelationKeys(relations)) {
    result[key] = sortedRelationEdges(relations[key] ?? []).map(serializeRelationEdge);
  }
  return result;
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

function orderedRelationKeys(relations: RelationMap): string[] {
  const keys = Object.keys(relations);
  const schemaKeys = SCHEMA_RELATION_ORDER.filter((key) => keys.includes(key));
  const userKeys = keys
    .filter((key) => !SCHEMA_RELATION_ORDER.includes(key))
    .sort((a, b) => a.localeCompare(b));
  return [...schemaKeys, ...userKeys];
}

function sortedRelationEdges(edges: RelationEdge[]): RelationEdge[] {
  return edges
    .map((edge, index) => ({ edge, index }))
    .sort((a, b) => {
      const aConfidence = a.edge.confidence;
      const bConfidence = b.edge.confidence;
      if (aConfidence !== undefined && bConfidence !== undefined && aConfidence !== bConfidence) {
        return bConfidence - aConfidence;
      }
      if (aConfidence !== undefined && bConfidence === undefined) return -1;
      if (aConfidence === undefined && bConfidence !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ edge }) => edge);
}

function serializeRelationEdge(edge: RelationEdge): SerializedRelationEdge {
  const extra = edge._extra ?? {};
  const source = edge.source ? { source: edge.source } : {};
  const record: Record<string, unknown> = {
    target: edge.target,
    ...(edge.confidence !== undefined ? { confidence: edge.confidence } : {}),
    ...(edge.valid_from !== undefined ? { valid_from: edge.valid_from } : {}),
    ...(edge.valid_to !== undefined ? { valid_to: edge.valid_to } : {}),
    ...(edge.superseded_by !== undefined ? { superseded_by: edge.superseded_by } : {}),
    ...source,
    ...extra,
  };
  return Object.keys(record).length === 1 ? edge.target : record;
}
