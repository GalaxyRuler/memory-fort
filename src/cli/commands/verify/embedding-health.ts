import {
  loadEmbeddings,
  type EmbeddingKind,
  type EmbeddingRecord,
} from "../../../retrieval/embeddings-store.js";
import { analyzeEmbeddingHealth } from "../../../retrieval/embedding-health.js";
import {
  getActiveEmbedderConfig,
  listEmbedderProviders,
} from "../../../retrieval/embedder/factory.js";
import { loadMemoryConfig, type MemoryConfig } from "../../../storage/config.js";
import { fail, pass, warn, type CheckDescriptor, type VerifyCheckResult } from "./types.js";

export interface EmbeddingHealthCheckOptions {
  configLoader?: () => Promise<MemoryConfig>;
}

const EMBEDDING_KINDS: EmbeddingKind[] = ["wiki", "raw", "crystal"];
const MIN_EMBEDDING_DIM = 16;

export const embeddingHealthCheck: CheckDescriptor = {
  id: "retrieval.embedding-health",
  label: "embedding health",
  roles: ["operator", "server"],
  run: async (ctx) => checkEmbeddingHealth(ctx.vaultRoot),
};

export async function checkEmbeddingHealth(
  vaultRoot: string,
  opts: EmbeddingHealthCheckOptions = {},
): Promise<VerifyCheckResult> {
  const config = await (opts.configLoader ?? (() => loadMemoryConfig(vaultRoot)))();
  const expectedDim = expectedEmbeddingDim(config);
  const records: EmbeddingRecord[] = [];
  const parseWarnings: string[] = [];

  for (const kind of EMBEDDING_KINDS) {
    const loaded = await loadEmbeddings(vaultRoot, kind);
    records.push(...loaded.records);
    for (const warning of loaded.warnings) {
      parseWarnings.push(`${kind}:${warning.line} ${warning.reason}`);
    }
  }

  if (records.length === 0) {
    return warn(
      "retrieval.embedding-health",
      "embedding health",
      "no embedding sidecars found; vector retrieval is inactive and BM25+graph are the live retrieval signals",
      "set VOYAGE_API_KEY and run `memory provider reindex-embeddings --apply` before relying on vector search",
    );
  }

  const analysis = analyzeEmbeddingHealth(records, {
    expectedDim,
    minDim: MIN_EMBEDDING_DIM,
  });
  const issues = [...parseWarnings, ...analysis.issues];
  const dims = analysis.dims.length > 0 ? analysis.dims.join(", ") : "none";
  const detail = `${records.length} embedding records; dim ${dims}; ${issues.length > 0 ? issues.join("; ") : "sample is diverse"}`;

  if (issues.length > 0) {
    return fail(
      "retrieval.embedding-health",
      "embedding health",
      "set VOYAGE_API_KEY and run `memory provider reindex-embeddings --apply` to replace stub sidecars",
      detail,
    );
  }

  return pass(
    "retrieval.embedding-health",
    "embedding health",
    detail,
  );
}

function expectedEmbeddingDim(config: MemoryConfig): number | undefined {
  const explicit = config.embedding?.dim;
  if (typeof explicit === "number" && Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }
  try {
    const active = getActiveEmbedderConfig(config);
    return listEmbedderProviders(active).find((provider) => provider.active)?.dim;
  } catch {
    return undefined;
  }
}
