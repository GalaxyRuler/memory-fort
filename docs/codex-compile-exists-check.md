# Codex Implementation Brief — Compile Executor: write_page → append_page When Target Exists (Phase 4.18)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Every compile run re-proposes pages that already exist in the vault. The model sees `iaqar` mentioned hundreds of times in raw observations, looks at the stale `index.md`, doesn't see an entry, and emits `write_page wiki/projects/iaqar.md`. The executor's append-only safety rule then rejects it ("target already exists") — the operator gets a stale proposal stuck in their inbox on every run.

Root cause: `index.md` is only updated by the compile pipeline itself, but pages can enter the vault through other paths (manual promotes, inline creates). The executor relies only on what the model emitted (`write_page` vs `append_page`) rather than checking the filesystem.

**The fix:** in `applyOperation()` in `src/compile/execute.ts`, when a `write_page` op targets a path that already exists on disk, automatically **convert it to `append_page`** rather than rejecting it. The section from the `write_page` body becomes the appended section. Record the conversion in the per-op outcome (`kind: "write->append: target already existed"`).

This makes compile idempotent: re-running on the same observations produces appends to existing pages rather than failing proposals.

---

## Scope guard

### Task 1 — Auto-convert write_page → append_page in the executor

In `src/compile/execute.ts`, `applyOperation()` around the `write_page` case (~L169-172):

Current:
```ts
case "write_page": {
  if (existsSync(fullPath)) return { ok: false, reason: "target already exists" };
  await atomicWrite(fullPath, serializeFrontmatter(operation.frontmatter as Frontmatter, `${operation.body.trim()}\n`));
  return { ok: true };
}
```

Change to:
```ts
case "write_page": {
  if (existsSync(fullPath)) {
    // Page already exists — treat the body as an append section
    const current = await readFile(fullPath, "utf-8");
    const parsed = parseFrontmatter(current);
    const date = new Date().toISOString().slice(0, 10);
    const section = `## ${date} update\n\n${operation.body.trim()}`;
    await atomicWrite(fullPath, serializeFrontmatter(parsed.frontmatter, `${parsed.body.trimEnd()}\n\n${section}\n`));
    return { ok: true, converted: "write->append: target already existed" };
  }
  await atomicWrite(fullPath, serializeFrontmatter(operation.frontmatter as Frontmatter, `${operation.body.trim()}\n`));
  return { ok: true };
}
```

- The `converted` field must surface in the per-op outcome (the `CompileExecuteOutcome` type) so the CLI summary + dashboard show `"converted write→append: wiki/projects/iaqar.md"` — not silently hidden.
- Confidence gate: the converted append still runs through the confidence scorer. If low-confidence, stage it (the existing staging path handles `append_page` ops already — just route through it).

### Task 2 — Also update index.md after a successful promote

In `src/dashboard/proposed.ts`, `promoteCompileProposal()`, after applying the op: if `update_index` is not already part of the proposal's compile-op, append the new page's entry to `index.md` (the `update_index` op kind already exists for this). This prevents index drift when pages are promoted one at a time from the inbox rather than via a full compile run.

### Task 3 — Tests

- Existing test: `write_page` on non-existent path → creates page (unchanged).
- New test: `write_page` on an **existing** path → converts to append, appends a dated section, returns `converted: "write->append: target already existed"`, original content preserved.
- New test: a low-confidence converted append → staged to `compile-proposed/`, not applied directly.
- New test: `promoteCompileProposal` for a `write_page` op → `index.md` updated with the new entry.

### Task 4 — Docs

- `docs/ROADMAP.md`: Phase 4.18 shipped.
- `templates/prompts/compile.md`: add a note that `write_page` on an already-existing path auto-converts to an appended update — so the model doesn't need to perfectly track what exists.

You will **not**:
- Rewrite existing page body/frontmatter — only append a dated section.
- Change the confidence gate thresholds.
- Update `index.md` from the executor directly (only from `promoteCompileProposal`). The executor's `update_index` op kind already handles this when the model emits it.

---

## Acceptance contract

1. Running `memory compile --execute` twice on the same observations: second run produces `converted write→append` outcomes for already-existing pages, not "target already exists" failures.
2. `iaqar.md` and `veritrace.md` no longer re-appear as stuck proposals in the inbox after each compile.
3. `promoteCompileProposal` updates `index.md` so promoted pages are visible to the next compile.
4. Outcome summary shows conversions distinctly.
5. Full suite + typecheck + build clean.

---

## Commit boundaries

- Task 1: `fix: write_page auto-converts to append when target exists (Phase 4.18 Task 1)`
- Task 2: `fix: promote compile proposal updates index.md (Phase 4.18 Task 2)`
- Task 3-4: `test+docs: compile idempotency (Phase 4.18)`
