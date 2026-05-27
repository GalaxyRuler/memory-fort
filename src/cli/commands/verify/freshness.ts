import { join } from "node:path";
import { loadWiki, type WikiPage } from "../../../curation/checks.js";
import type { ConfidenceVector } from "../../../storage/frontmatter.js";
import {
  fail,
  pass,
  warn,
  type CheckDescriptor,
  type VerifyCheckContext,
  type VerifyCheckResult,
} from "./types.js";

const STALE_DAYS = 90;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;
const ID = "freshness.staleness";
const LABEL = "canonical memories are fresh";
const SUGGESTED_FIX =
  "run `memory log <page> --validate` to refresh, or set lifecycle: archived";

export const freshnessStaleCheck: CheckDescriptor = {
  id: ID,
  label: LABEL,
  roles: ["operator", "server"],
  run: checkFreshnessStaleness,
};

export async function checkFreshnessStaleness(
  ctx: VerifyCheckContext,
): Promise<VerifyCheckResult> {
  const pages = await loadWiki(join(ctx.vaultRoot, "wiki"));
  const canonicalPages = pages.filter(isCanonicalMemory);
  const nowMs = ctx.now().getTime();
  const staleCount = canonicalPages.filter((page) => {
    const timestamp = freshnessTimestamp(page);
    return timestamp !== null && nowMs - timestamp > STALE_MS;
  }).length;
  const canonicalCount = canonicalPages.length;
  const detail = `${staleCount}/${canonicalCount} canonical memories are >90d stale`;

  if (staleCount === 0) {
    return pass(ID, LABEL, detail);
  }

  const staleRatio = canonicalCount === 0 ? 0 : staleCount / canonicalCount;
  if (staleRatio >= 0.3 || staleCount >= 100) {
    return fail(ID, LABEL, SUGGESTED_FIX, detail);
  }
  if (staleRatio >= 0.1 || staleCount >= 20) {
    return warn(ID, LABEL, detail, SUGGESTED_FIX);
  }

  return pass(ID, LABEL, detail);
}

function isCanonicalMemory(page: WikiPage): boolean {
  if (page.frontmatter.lifecycle === "canonical") return true;
  if (page.frontmatter.lifecycle !== undefined) return false;
  return `wiki/${page.path}`.startsWith("wiki/") &&
    (page.frontmatter.status ?? "active") === "active";
}

function freshnessTimestamp(page: WikiPage): number | null {
  const confidence = page.frontmatter.confidence;
  if (isConfidenceVector(confidence) && typeof confidence.freshness === "string") {
    const freshness = Date.parse(confidence.freshness);
    if (Number.isFinite(freshness)) return freshness;
  }

  const updated = page.frontmatter.updated;
  if (typeof updated !== "string") return null;
  const parsed = Date.parse(updated);
  return Number.isFinite(parsed) ? parsed : null;
}

function isConfidenceVector(value: unknown): value is ConfidenceVector {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
