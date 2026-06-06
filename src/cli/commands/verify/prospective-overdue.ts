import { loadSearchCorpus, type SearchDocument } from "../../../retrieval/corpus.js";
import {
  fail,
  pass,
  warn,
  type CheckDescriptor,
  type VerifyCheckContext,
  type VerifyCheckResult,
} from "./types.js";

const ID = "prospective.overdue";
const LABEL = "prospective memories are not overdue";
const SUGGESTED_FIX =
  "review wiki/prospective/ and update lifecycle on completed or expired prospective memories";

export const prospectiveOverdueCheck: CheckDescriptor = {
  id: ID,
  label: LABEL,
  roles: ["operator", "server"],
  run: checkProspectiveOverdue,
};

export async function checkProspectiveOverdue(
  ctx: VerifyCheckContext,
): Promise<VerifyCheckResult> {
  const corpus = await loadSearchCorpus({ vaultRoot: ctx.vaultRoot, scope: "wiki" });
  const prospective = corpus.documents.filter(isLiveProposedProspective);
  const nowMs = ctx.now().getTime();
  const overdue = prospective.filter((document) => isOverdue(document, nowMs));
  const detail = detailFor(overdue, prospective.length);

  if (overdue.length === 0) {
    return pass(ID, LABEL, detail);
  }
  if (overdue.length >= 3) {
    return fail(ID, LABEL, SUGGESTED_FIX, detail);
  }
  return warn(ID, LABEL, detail, SUGGESTED_FIX);
}

function isLiveProposedProspective(document: SearchDocument): boolean {
  return document.cognitiveType === "prospective" &&
    document.lifecycle === "proposed" &&
    document.status !== "archived" &&
    !document.relPath.startsWith("wiki/archive/");
}

function isOverdue(document: SearchDocument, nowMs: number): boolean {
  if (!document.due) return false;
  const dueMs = Date.parse(document.due);
  return Number.isFinite(dueMs) && dueMs < nowMs;
}

function detailFor(overdue: SearchDocument[], total: number): string {
  const summary = `${overdue.length}/${total} proposed prospective memories are overdue`;
  if (overdue.length === 0) return summary;
  const examples = overdue
    .slice(0, 3)
    .map((document) => document.relPath)
    .join(", ");
  return `${summary}: ${examples}`;
}
