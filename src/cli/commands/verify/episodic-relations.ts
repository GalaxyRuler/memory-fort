import { loadSearchCorpus } from "../../../retrieval/corpus.js";
import { pass, warn, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

const MIN_LINKED_RATIO = 0.3;

export async function checkEpisodicRelations(
  ctx: VerifyCheckContext,
): Promise<VerifyCheckResult> {
  const corpus = await loadSearchCorpus({ vaultRoot: ctx.vaultRoot, scope: "raw" });
  const observations = corpus.documents.filter((doc) => doc.kind === "raw");
  if (observations.length === 0) {
    return pass("episodic.relations.coverage", "no episodic memories found");
  }

  const linked = observations.filter((doc) => hasAnyRelation(doc.relations)).length;
  const orphaned = observations.length - linked;
  const ratio = linked / observations.length;
  const percent = Math.round(ratio * 100);
  const label = `${percent}% of episodic memories have >=1 relation`;
  const detail = `${linked}/${observations.length} linked; ${orphaned} orphaned`;

  if (ratio < MIN_LINKED_RATIO) {
    return warn(
      "episodic.relations.coverage",
      label,
      detail,
      "run `memory consolidate --plan`, then `memory consolidate --apply` if the proposed links look right",
    );
  }
  return pass("episodic.relations.coverage", label, detail);
}

function hasAnyRelation(relations: Record<string, string[]>): boolean {
  return Object.values(relations).some((targets) => targets.length > 0);
}
