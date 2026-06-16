import { loadSearchCorpus } from "../../../retrieval/corpus.js";
import {
  fail,
  pass,
  warn,
  type CheckDescriptor,
  type VerifyCheckContext,
  type VerifyCheckResult,
} from "./types.js";

const ID = "frontmatter.source";
const LABEL = "wiki pages have source provenance";
const SUGGESTED_FIX = "run `memory backfill-source --apply`";

export const sourceFieldCheck: CheckDescriptor = {
  id: ID,
  label: LABEL,
  roles: ["operator", "server"],
  run: checkSourceField,
};

export async function checkSourceField(ctx: VerifyCheckContext): Promise<VerifyCheckResult> {
  const corpus = await loadSearchCorpus({ vaultRoot: ctx.vaultRoot, scope: "wiki" });
  const live = corpus.documents.filter(
    (document) =>
      !document.relPath.startsWith("wiki/archive/") &&
      !isAuditLogFile(document.relPath),
  );
  const missing = live.filter((document) => lacksSource(document.source));

  if (missing.length === 0) {
    return pass(ID, LABEL, `all ${live.length} live wiki pages have source provenance`);
  }

  const summary = `${missing.length}/${live.length} live wiki pages lack source`;
  if (missing.length <= 2) {
    return warn(ID, LABEL, summary, SUGGESTED_FIX);
  }

  const examples = missing.slice(0, 5).map((document) => document.relPath).join(", ");
  return fail(ID, LABEL, SUGGESTED_FIX, `${summary}: ${examples}`);
}

function lacksSource(source: unknown): boolean {
  return typeof source !== "string" || source.trim().length === 0 || source === "unknown";
}

// log.md is an append-only audit trail (no frontmatter / no source by design),
// not a curated knowledge page; it must not count toward source provenance.
function isAuditLogFile(relPath: string): boolean {
  return (relPath.replace(/\\/g, "/").split("/").pop() ?? "") === "log.md";
}
