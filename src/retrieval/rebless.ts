import type { SearchDocument } from "./corpus.js";
import {
  assertEmbeddingsWritable,
  loadEmbeddings,
  saveEmbeddings,
  type EmbeddingKind,
  type EmbeddingRecord,
} from "./embeddings-store.js";
import {
  hashEmbeddingBody,
  hashLegacyEmbeddingBody,
  toEmbeddingText,
} from "./embedding-text.js";

export interface ReblessRedactionOnlyOptions {
  memoryRoot: string;
  currentDocuments: SearchDocument[];
  baselineDocuments: SearchDocument[];
  expectedDim: number;
  mode?: "plan" | "apply";
  now?: () => Date;
}

export interface ReblessRedactionOnlyResult {
  reblessed: number;
  unchanged: number;
  skipped: number;
  errors: Array<{ path: string; reason: string }>;
  totalRecords: number;
}

export async function reblessRedactionOnlyEmbeddings(
  opts: ReblessRedactionOnlyOptions,
): Promise<ReblessRedactionOnlyResult> {
  const now = opts.now ?? (() => new Date());
  const mode = opts.mode ?? "apply";
  const currentByPath = new Map(opts.currentDocuments.map((document) => [document.relPath, document]));
  const baselineByPath = new Map(opts.baselineDocuments.map((document) => [document.relPath, document]));
  const result: ReblessRedactionOnlyResult = {
    reblessed: 0,
    unchanged: 0,
    skipped: 0,
    errors: [],
    totalRecords: 0,
  };

  for (const kind of documentKinds(opts.currentDocuments)) {
    const loaded = await loadEmbeddings(opts.memoryRoot, kind);
    for (const warning of loaded.warnings) {
      result.errors.push({
        path: `embeddings/${kind}.embeddings.jsonl:${warning.line}`,
        reason: warning.reason,
      });
    }
    if (loaded.warnings.length > 0) continue;

    let changed = false;
    const next: EmbeddingRecord[] = [];
    for (const record of loaded.records) {
      const current = currentByPath.get(record.path);
      const baseline = baselineByPath.get(record.path);
      if (!current || !baseline || current.kind !== kind || baseline.kind !== kind) {
        next.push(record);
        result.skipped += 1;
        continue;
      }

      const currentHash = hashEmbeddingBody(current.body);
      if (record.hash === currentHash) {
        next.push(record);
        result.unchanged += 1;
        continue;
      }

      const legacyBaselineHash = hashLegacyEmbeddingBody(baseline.body);
      const stableBaselineHash = hashEmbeddingBody(baseline.body);
      const baselineMatchesRecord =
        record.hash === legacyBaselineHash || record.hash === stableBaselineHash;
      const redactionOnly =
        toEmbeddingText(baseline.body) === toEmbeddingText(current.body);

      if (!baselineMatchesRecord || !redactionOnly) {
        next.push(record);
        result.skipped += 1;
        continue;
      }

      try {
        assertEmbeddingsWritable([record], opts.expectedDim);
      } catch {
        next.push(record);
        result.errors.push({
          path: record.path,
          reason: `refusing to rebless ${record.path}: vector dim ${record.dim} does not match expected ${opts.expectedDim}`,
        });
        continue;
      }

      next.push({
        ...record,
        hash: currentHash,
        ts: now().toISOString(),
      });
      changed = true;
      result.reblessed += 1;
    }

    if (mode === "apply" && changed && result.errors.length === 0) {
      await saveEmbeddings(opts.memoryRoot, kind, next, { expectedDim: opts.expectedDim });
    }
    result.totalRecords += next.length;
  }

  return result;
}

function documentKinds(documents: SearchDocument[]): EmbeddingKind[] {
  const kinds = new Set<EmbeddingKind>();
  for (const document of documents) kinds.add(document.kind);
  return [...kinds].sort();
}
