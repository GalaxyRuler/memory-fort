import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, basename } from "node:path";
import { parseFrontmatter, serializeFrontmatter } from "../storage/frontmatter.js";
import { atomicWrite } from "../storage/atomic-write.js";

interface ApproveOpts {
  vaultRoot: string;
  proposalPath: string;
  now?: Date;
}

type ApproveResult =
  | { ok: true }
  | { ok: false; reason: string };

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply an approved supersede proposal to the old page.
 *
 * Crash-safe but not transactionally atomic: three sequential writes
 * (archive, old-page patch, proposal marking). Rerunning after a partial
 * failure is idempotent — the archive is append-only, the old page is
 * re-patched with identical values, and the proposal is re-marked.
 */
export async function applyApprovedSupersedeProposal(
  opts: ApproveOpts,
): Promise<ApproveResult> {
  const now = opts.now ?? new Date();
  const isoDate = now.toISOString().slice(0, 10);

  // Proposal path safety: must be inside wiki/compile-proposed/
  const proposalFullPath = resolve(opts.proposalPath);
  const proposedRoot = resolve(opts.vaultRoot, "wiki", "compile-proposed");
  const proposalRel = relative(proposedRoot, proposalFullPath);
  if (proposalRel.startsWith("..") || proposalRel === "" || isAbsolute(proposalRel)) {
    return { ok: false, reason: "proposal must be inside wiki/compile-proposed" };
  }

  // Read proposal
  let proposalRaw: string;
  try {
    proposalRaw = await readFile(proposalFullPath, "utf-8");
  } catch {
    return { ok: false, reason: `proposal not found: ${opts.proposalPath}` };
  }

  const proposal = parseFrontmatter(proposalRaw);
  const oldPageRel = proposal.frontmatter["old_page"] as string | undefined;
  const newPageRel = proposal.frontmatter["new_page"] as string | undefined;
  const patch = proposal.frontmatter["old_page_patch"] as
    | { valid_until?: string; status?: string }
    | undefined;

  if (!oldPageRel || !patch) {
    return { ok: false, reason: "proposal missing old_page or old_page_patch" };
  }

  // Path safety: old_page must resolve inside vaultRoot
  const oldFullPath = resolve(opts.vaultRoot, oldPageRel);
  const relCheck = relative(resolve(opts.vaultRoot), oldFullPath);
  if (relCheck.startsWith("..") || isAbsolute(relCheck)) {
    return { ok: false, reason: `path traversal blocked: ${oldPageRel}` };
  }

  // Read old page
  let oldRaw: string;
  try {
    oldRaw = await readFile(oldFullPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: `old page not found: ${oldPageRel}` };
    }
    throw err;
  }

  // Verify replacement page exists before touching anything
  if (newPageRel) {
    const newFullPath = resolve(opts.vaultRoot, newPageRel);
    if (!(await fileExists(newFullPath))) {
      return { ok: false, reason: `replacement page not found: ${newPageRel}` };
    }
  }

  const oldParsed = parseFrontmatter(oldRaw);

  // Step 1: Archive old page version (append-only, duplicate-safe)
  const archiveDir = join(opts.vaultRoot, "wiki", ".archive");
  await mkdir(archiveDir, { recursive: true });
  const archiveName = `${basename(oldPageRel, ".md")}-${now.getTime()}.md`;
  await writeFile(join(archiveDir, archiveName), oldRaw);

  // Step 2: Patch old page — add temporal bounds + superseded status
  const patchedFm = {
    ...oldParsed.frontmatter,
    ...(patch.valid_until ? { valid_until: patch.valid_until } : {}),
    ...(patch.status ? { status: patch.status as "superseded" } : {}),
    updated: isoDate,
  };
  if (newPageRel) {
    const existingRelations = (patchedFm.relations ?? {}) as Record<string, unknown>;
    patchedFm.relations = {
      ...existingRelations,
      superseded_by: [newPageRel],
    };
  }
  await atomicWrite(
    oldFullPath,
    serializeFrontmatter(patchedFm, `${oldParsed.body.trimEnd()}\n`),
  );

  // Step 3: Mark proposal as approved (idempotent — safe to rerun)
  const proposalFm = {
    ...proposal.frontmatter,
    proposal_status: "approved",
    updated: isoDate,
  };
  await atomicWrite(
    proposalFullPath,
    serializeFrontmatter(proposalFm, `${proposal.body.trimEnd()}\n`),
  );

  return { ok: true };
}
