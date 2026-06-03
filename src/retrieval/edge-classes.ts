export type EdgeClass = "reasoning" | "provenance" | "association";

export const REASONING_EDGE_TYPES = [
  "uses",
  "depends_on",
  "caused_by",
  "fixed_by",
  "contradicts",
  "supersedes",
  "learned_from",
] as const;

export const PROVENANCE_EDGE_TYPES = [
  "derived_from",
  "mentioned_in",
  "mentions",
] as const;

export const ASSOCIATION_EDGE_TYPES = [
  "linked",
  "wikilink",
] as const;

const REASONING = new Set<string>(REASONING_EDGE_TYPES);
const PROVENANCE = new Set<string>(PROVENANCE_EDGE_TYPES);
const ASSOCIATION = new Set<string>(ASSOCIATION_EDGE_TYPES);

export interface ClassifiableEdge {
  kind?: string | null;
  relationType?: string | null;
  type?: string | null;
}

export function edgeClass(edge: ClassifiableEdge): EdgeClass {
  const key = edge.relationType ?? (edge.kind === "wikilink" ? "wikilink" : edge.type ?? edge.kind ?? "");
  if (REASONING.has(key)) return "reasoning";
  if (PROVENANCE.has(key)) return "provenance";
  if (ASSOCIATION.has(key)) return "association";
  return "association";
}

export function isReasoningEdge(edge: ClassifiableEdge): boolean {
  return edgeClass(edge) === "reasoning";
}

export function isProvenanceEdge(edge: ClassifiableEdge): boolean {
  return edgeClass(edge) === "provenance";
}

export function isAssociationEdge(edge: ClassifiableEdge): boolean {
  return edgeClass(edge) === "association";
}
