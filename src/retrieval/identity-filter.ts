import type { SearchDocument } from "./corpus.js";

export interface IdentityFilter {
  agentId?: string;
  userId?: string;
  mode?: "inclusive" | "strict";
}

/**
 * Identity-aware retrieval filtering. NOT security isolation — a retrieval
 * preference for a personal vault.
 *
 * Inclusive (default): untagged docs (curated wiki pages) always pass;
 * tagged docs must match the requested identity.
 * Strict: only docs with matching identity tags pass; untagged excluded.
 */
export function filterDocumentsByIdentity(
  docs: SearchDocument[],
  filter: IdentityFilter,
): SearchDocument[] {
  const { agentId, userId, mode = "inclusive" } = filter;
  if (!agentId && !userId) return docs;

  return docs.filter((doc) => {
    const rf = doc.rawFrontmatter;
    const docAgentId = rf ? (rf["agent_id"] as string | undefined) : undefined;
    const docUserId = rf ? (rf["user_id"] as string | undefined) : undefined;
    const hasAnyIdentity = !!(docAgentId || docUserId);

    if (mode === "strict") {
      if (agentId && docAgentId !== agentId) return false;
      if (userId && docUserId !== userId) return false;
      if (!hasAnyIdentity) return false;
      return true;
    }

    // Inclusive: untagged docs pass; tagged docs must match
    if (!hasAnyIdentity) return true;
    if (agentId && docAgentId !== undefined && docAgentId !== agentId) return false;
    if (userId && docUserId !== undefined && docUserId !== userId) return false;
    // Doc has SOME identity tags but not the dimension being filtered — exclude
    if (agentId && docAgentId === undefined && hasAnyIdentity) return false;
    if (userId && docUserId === undefined && hasAnyIdentity) return false;
    return true;
  });
}
