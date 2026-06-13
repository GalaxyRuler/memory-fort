import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadSearchCorpus } from "../retrieval/corpus.js";
import { readRelations, writeRelations, type RelationMap } from "../retrieval/relations.js";
import { isEntityWikiPath } from "../retrieval/wiki-paths.js";
import { atomicWrite } from "../storage/atomic-write.js";
import { parseFrontmatter, serializeFrontmatter } from "../storage/frontmatter.js";
import { kebabCase } from "../storage/slug.js";

export interface EntityRecord {
  name: string;
  relPath?: string;
  type?: string;
  referenceCount?: number;
  isWikiTitle?: boolean;
}

export interface DuplicatePair {
  leftName: string;
  rightName: string;
  leftRelPath?: string;
  rightRelPath?: string;
  normalized: string;
  reason: "exact-normalized" | "high-similarity";
  similarity: number;
  leftReferenceCount: number;
  rightReferenceCount: number;
  suggestedCanonical: string;
}

export interface EntityMergeProposal {
  canonical: string;
  canonicalTarget: string;
  aliases: string[];
  normalized: string;
  reason: DuplicatePair["reason"];
  referenceCounts: Record<string, number>;
}

export interface EntityAliasMap {
  version: 1;
  updatedAt: string;
  aliases: Record<string, string>;
}

export interface EntityMergeResult {
  canonical: string;
  aliases: string[];
  changedFiles: string[];
  aliasMapPath: string;
}

const SIMILARITY_THRESHOLD = 0.85;
const PROPOSALS_REL_PATH = "wiki/entity-merges-proposed.json";
const ALIASES_REL_PATH = "wiki/.entity-aliases.json";

export function normalizeEntityName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function findDuplicateEntityPairs(entities: EntityRecord[]): DuplicatePair[] {
  const cleaned = entities
    .map((entity) => ({
      ...entity,
      name: entity.name.trim(),
      normalized: normalizeEntityName(entity.name),
      referenceCount: entity.referenceCount ?? 0,
    }))
    .filter((entity) => entity.name.length > 0 && entity.normalized.length > 0);

  const pairs: DuplicatePair[] = [];
  for (let leftIndex = 0; leftIndex < cleaned.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < cleaned.length; rightIndex += 1) {
      const left = cleaned[leftIndex]!;
      const right = cleaned[rightIndex]!;
      if (left.type && right.type && left.type !== right.type) continue;

      const exact = left.normalized === right.normalized;
      const similarity = exact ? 1 : entitySimilarity(left.normalized, right.normalized);
      if (!exact && similarity < SIMILARITY_THRESHOLD) continue;

      const [aliasSide, canonicalSide] = orderAliasAndCanonical(left, right);
      pairs.push({
        leftName: aliasSide.name,
        rightName: canonicalSide.name,
        leftRelPath: aliasSide.relPath,
        rightRelPath: canonicalSide.relPath,
        normalized: exact ? left.normalized : commonNormalized(left.normalized, right.normalized),
        reason: exact ? "exact-normalized" : "high-similarity",
        similarity,
        leftReferenceCount: aliasSide.referenceCount,
        rightReferenceCount: canonicalSide.referenceCount,
        suggestedCanonical: chooseCanonical(left, right).name,
      });
    }
  }

  return pairs.sort((a, b) =>
    a.normalized.localeCompare(b.normalized) ||
    b.similarity - a.similarity ||
    a.leftName.localeCompare(b.leftName) ||
    a.rightName.localeCompare(b.rightName)
  );
}

export async function collectEntityMergeProposals(vaultRoot: string): Promise<EntityMergeProposal[]> {
  const corpus = await loadSearchCorpus({ vaultRoot, scope: "all" });
  const wikiDocs = corpus.documents.filter((document) =>
    document.kind === "wiki"
    && isEntityWikiPath(document.relPath)
    // Archived pages are merge artifacts and historical records — matching
    // them against live pages re-proposes every completed merge forever.
    && !document.relPath.startsWith("wiki/archive/")
  );
  const counts = new Map<string, number>();
  const records = wikiDocs.map((document): EntityRecord => {
    counts.set(document.relPath, 1);
    counts.set(document.title, 1);
    return {
      name: document.title,
      relPath: document.relPath,
      type: document.type,
      referenceCount: 1,
      isWikiTitle: true,
    };
  });

  for (const document of corpus.documents) {
    for (const edges of Object.values(document.relations)) {
      for (const edge of edges) {
        const target = edge.target;
        counts.set(target, (counts.get(target) ?? 0) + 1);
      }
    }
  }

  const enriched = records.map((record) => ({
    ...record,
    referenceCount: Math.max(
      counts.get(record.relPath ?? "") ?? 0,
      counts.get(record.name) ?? 0,
      record.referenceCount ?? 0,
    ),
  }));

  return findDuplicateEntityPairs(enriched).map((pair) => {
    const canonical = pair.suggestedCanonical;
    const canonicalRecord = enriched.find((record) => record.name === canonical);
    const aliases = uniqueSorted([
      pair.leftName,
      pair.rightName,
      pair.leftRelPath,
      pair.rightRelPath,
    ].filter((alias): alias is string => Boolean(alias) && alias !== canonical && alias !== canonicalRecord?.relPath));
    return {
      canonical,
      canonicalTarget: canonicalRecord?.relPath ?? canonical,
      aliases,
      normalized: pair.normalized,
      reason: pair.reason,
      referenceCounts: {
        [pair.leftName]: pair.leftReferenceCount,
        [pair.rightName]: pair.rightReferenceCount,
      },
    };
  });
}

export async function writeEntityMergeProposals(vaultRoot: string, proposals: EntityMergeProposal[]): Promise<string> {
  const fullPath = join(vaultRoot, ...PROPOSALS_REL_PATH.split("/"));
  await atomicWrite(fullPath, `${JSON.stringify({ version: 1, proposals }, null, 2)}\n`);
  return PROPOSALS_REL_PATH;
}

export async function readEntityMergeProposals(vaultRoot: string): Promise<EntityMergeProposal[]> {
  const fullPath = join(vaultRoot, ...PROPOSALS_REL_PATH.split("/"));
  if (!existsSync(fullPath)) return [];
  const parsed = JSON.parse(await readFile(fullPath, "utf-8")) as { proposals?: unknown };
  return Array.isArray(parsed.proposals) ? parsed.proposals.flatMap(readProposal) : [];
}

export async function rejectEntityMergeProposal(vaultRoot: string, canonical: string): Promise<EntityMergeProposal> {
  const proposals = await readEntityMergeProposals(vaultRoot);
  const index = proposals.findIndex((proposal) => proposalMatches(proposal, canonical));
  if (index < 0) throw new Error(`entity merge proposal not found: ${canonical}`);
  const [removed] = proposals.splice(index, 1);
  await writeEntityMergeProposals(vaultRoot, proposals);
  return removed!;
}

export async function mergeEntityProposal(vaultRoot: string, canonical: string): Promise<EntityMergeResult> {
  const proposals = await readEntityMergeProposals(vaultRoot);
  const proposal = proposals.find((candidate) => proposalMatches(candidate, canonical));
  if (!proposal) throw new Error(`entity merge proposal not found: ${canonical}`);
  return mergeEntityAliases({
    vaultRoot,
    canonical: proposal.canonicalTarget,
    aliases: proposal.aliases,
  });
}

export async function readEntityAliasMap(vaultRoot: string): Promise<EntityAliasMap> {
  const fullPath = join(vaultRoot, ...ALIASES_REL_PATH.split("/"));
  if (!existsSync(fullPath)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), aliases: {} };
  }
  const parsed = JSON.parse(await readFile(fullPath, "utf-8")) as Partial<EntityAliasMap>;
  return {
    version: 1,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    aliases: typeof parsed.aliases === "object" && parsed.aliases !== null ? parsed.aliases as Record<string, string> : {},
  };
}

export async function mergeEntityAliases(opts: {
  vaultRoot: string;
  canonical: string;
  aliases: string[];
  now?: Date;
}): Promise<EntityMergeResult> {
  const canonical = opts.canonical.trim();
  const aliases = uniqueSorted(opts.aliases.map((alias) => alias.trim()).filter((alias) => alias.length > 0 && alias !== canonical));
  const aliasSet = new Set(aliases);
  const aliasNormals = new Set(aliases.map(normalizeEntityName));
  const changedFiles: string[] = [];

  for (const relPath of await collectRelationMarkdownFiles(opts.vaultRoot)) {
    const fullPath = join(opts.vaultRoot, ...relPath.split("/"));
    const parsed = parseFrontmatter(await readFile(fullPath, "utf-8"));
    const relations = readRelations(parsed.frontmatter.relations, relPath);
    const rewritten = rewriteRelationMap(relations, canonical, aliasSet, aliasNormals);
    if (!rewritten.changed) continue;
    await atomicWrite(
      fullPath,
      serializeFrontmatter({
        ...parsed.frontmatter,
        relations: writeRelations(rewritten.relations),
      }, parsed.body),
    );
    changedFiles.push(relPath);
  }

  // Archive the alias pages themselves — leaving them live keeps duplicate
  // content in search results and the duplicate-entities health metric warm.
  // Archive (never delete): move under wiki/archive/ with provenance.
  for (const alias of aliases) {
    if (!alias.startsWith("wiki/") || !alias.endsWith(".md")) continue;
    const aliasFullPath = join(opts.vaultRoot, ...alias.split("/"));
    if (!existsSync(aliasFullPath)) continue;
    const parsed = parseFrontmatter(await readFile(aliasFullPath, "utf-8"));
    const baseName = alias.split("/").at(-1)!;
    let archiveRelPath = `wiki/archive/${baseName}`;
    if (existsSync(join(opts.vaultRoot, ...archiveRelPath.split("/")))) {
      archiveRelPath = `wiki/archive/${baseName.replace(/\.md$/, "")}-${(opts.now ?? new Date()).getTime()}.md`;
    }
    await atomicWrite(
      join(opts.vaultRoot, ...archiveRelPath.split("/")),
      serializeFrontmatter(
        {
          ...parsed.frontmatter,
          status: "archived",
          superseded_by: canonical,
          updated: (opts.now ?? new Date()).toISOString().slice(0, 10),
        },
        parsed.body,
      ),
    );
    await rm(aliasFullPath);
    changedFiles.push(alias, archiveRelPath);
  }

  const aliasMap = await readEntityAliasMap(opts.vaultRoot);
  const nextAliases = { ...aliasMap.aliases };
  for (const alias of aliases) nextAliases[alias] = canonical;
  await atomicWrite(
    join(opts.vaultRoot, ...ALIASES_REL_PATH.split("/")),
    `${JSON.stringify({
      version: 1,
      updatedAt: (opts.now ?? new Date()).toISOString(),
      aliases: Object.fromEntries(Object.entries(nextAliases).sort(([a], [b]) => a.localeCompare(b))),
    } satisfies EntityAliasMap, null, 2)}\n`,
  );

  return {
    canonical,
    aliases,
    changedFiles,
    aliasMapPath: ALIASES_REL_PATH,
  };
}

function rewriteRelationMap(
  relations: RelationMap,
  canonical: string,
  aliasSet: Set<string>,
  aliasNormals: Set<string>,
): { relations: RelationMap; changed: boolean } {
  let changed = false;
  const next: RelationMap = {};
  for (const [key, edges] of Object.entries(relations)) {
    next[key] = edges.map((edge) => {
      if (edge.target === canonical) return edge;
      if (!aliasSet.has(edge.target) && !aliasNormals.has(normalizeEntityName(edge.target))) return edge;
      changed = true;
      return { ...edge, target: canonical };
    });
  }
  return { relations: next, changed };
}

function orderAliasAndCanonical<T extends EntityRecord & { referenceCount: number }>(left: T, right: T): [T, T] {
  const canonical = chooseCanonical(left, right);
  return canonical === left ? [right, left] : [left, right];
}

function chooseCanonical<T extends EntityRecord & { referenceCount: number }>(left: T, right: T): T {
  if (left.isWikiTitle && !right.isWikiTitle) return left;
  if (!left.isWikiTitle && right.isWikiTitle) return right;
  if (left.referenceCount !== right.referenceCount) return left.referenceCount > right.referenceCount ? left : right;
  return left.name.localeCompare(right.name) <= 0 ? left : right;
}

function commonNormalized(left: string, right: string): string {
  return left.length <= right.length ? left : right;
}

function entitySimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const distance = levenshtein(left, right);
  const editSimilarity = 1 - distance / Math.max(left.length, right.length, 1);
  return Math.max(editSimilarity, jaccard(bigrams(left), bigrams(right)));
}

function bigrams(value: string): Set<string> {
  if (value.length < 2) return new Set([value]);
  const grams = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.add(value.slice(index, index + 2));
  }
  return grams;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return intersection / union.size;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

async function collectRelationMarkdownFiles(vaultRoot: string): Promise<string[]> {
  const roots = ["wiki", "raw"];
  const files: string[] = [];
  for (const root of roots) {
    await walk(join(vaultRoot, root));
  }
  return files.sort();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(relative(vaultRoot, fullPath).replace(/\\/g, "/"));
      }
    }
  }
}

function readProposal(value: unknown): EntityMergeProposal[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (
    typeof record.canonical !== "string" ||
    typeof record.canonicalTarget !== "string" ||
    !Array.isArray(record.aliases)
  ) {
    return [];
  }
  return [{
    canonical: record.canonical,
    canonicalTarget: record.canonicalTarget,
    aliases: record.aliases.filter((alias): alias is string => typeof alias === "string"),
    normalized: typeof record.normalized === "string" ? record.normalized : normalizeEntityName(record.canonical),
    reason: record.reason === "high-similarity" ? "high-similarity" : "exact-normalized",
    referenceCounts: typeof record.referenceCounts === "object" && record.referenceCounts !== null
      ? record.referenceCounts as Record<string, number>
      : {},
  }];
}

function proposalMatches(proposal: EntityMergeProposal, input: string): boolean {
  return proposal.canonical === input ||
    proposal.canonicalTarget === input ||
    kebabCase(proposal.canonical) === input ||
    normalizeEntityName(proposal.canonical) === normalizeEntityName(input);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
