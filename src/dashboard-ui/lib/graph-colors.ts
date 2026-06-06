export const ENTITY_COLORS: Record<string, string> = {
  projects: "#4ade80",      // green — growth, building
  issues: "#fb7185",        // rose — failures and blockers
  decisions: "#f472b6",     // pink — critical thinking
  lessons: "#a78bfa",       // violet — wisdom
  references: "#60a5fa",     // blue — knowledge
  tools: "#fbbf24",          // amber — utility
  people: "#f472b6",         // pink
  crystal: "#22d3ee",        // cyan — crystallized insight
  "raw-session": "#5c6478",  // text-muted zinc
};

export const RELATION_COLORS: Record<string, string> = {
  uses: "#60a5fa",
  depends_on: "#4ade80",
  supersedes: "#fbbf24",
  contradicts: "#ef4444",
  caused_by: "#f97316",
  fixed_by: "#4ade80",
  derived_from: "#a78bfa",
  mentioned_in: "rgb(155, 164, 184)",
  linked: "rgb(34, 211, 238)",
};

export function nodeColor(node: { type: string; kind: string }): string {
  if (node.type && ENTITY_COLORS[node.type]) return ENTITY_COLORS[node.type];
  if (node.kind === "raw") return ENTITY_COLORS["raw-session"];
  if (node.kind === "crystal") return ENTITY_COLORS.crystal;
  return "#60a5fa";
}

export function edgeColor(edge: { kind: string; relationType: string | null }): string {
  if (edge.kind === "wikilink") return RELATION_COLORS.linked;
  if (edge.relationType && RELATION_COLORS[edge.relationType]) return RELATION_COLORS[edge.relationType];
  return "rgb(155, 164, 184)";
}
