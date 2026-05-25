export const ENTITY_COLORS: Record<string, string> = {
  projects: "#5b8bff",
  decisions: "#8b5fff",
  lessons: "#fbbf24",
  references: "#22d3ee",
  tools: "#34d399",
  people: "#f472b6",
  crystal: "#fcd34d",
  "raw-session": "#52525b",
};

export const RELATION_COLORS: Record<string, string> = {
  uses: "#5b8bff",
  depends_on: "#34d399",
  supersedes: "#fbbf24",
  contradicts: "#f87171",
  caused_by: "#fb923c",
  fixed_by: "#34d399",
  derived_from: "#8b5fff",
  mentioned_in: "rgb(237,237,237)",
  linked: "rgb(91,139,255)",
};

export function nodeColor(node: { type: string; kind: string }): string {
  if (node.type && ENTITY_COLORS[node.type]) return ENTITY_COLORS[node.type];
  if (node.kind === "raw") return ENTITY_COLORS["raw-session"];
  if (node.kind === "crystal") return ENTITY_COLORS.crystal;
  return "#5b8bff";
}

export function edgeColor(edge: { kind: string; relationType: string | null }): string {
  if (edge.kind === "wikilink") return RELATION_COLORS.linked;
  if (edge.relationType && RELATION_COLORS[edge.relationType]) return RELATION_COLORS[edge.relationType];
  return "rgb(237,237,237)";
}
