# Codex Implementation Brief — Unify the Relation-Type Lists (Phase 4.12)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

A documentation-reconciliation pass (2026-05-29) surfaced a real code inconsistency: there are **two divergent canonical relation-type lists**.

- `KNOWN_RELATIONS` in `src/storage/frontmatter.ts` (~L94-105) — the set `validateFrontmatter` enforces; it **rejects** any other edge key. **10 types**, NO `supports`:
  `uses, depends_on, supersedes, contradicts, caused_by, fixed_by, derived_from, mentions, mentioned_in, linked`
- `SCHEMA_RELATION_ORDER` in `src/retrieval/relations.ts` (~L21-33) — used to order relations on read/serialize. **11 types**, INCLUDING `supports`:
  `mentions, supports, contradicts, supersedes, derived_from, uses, depends_on, caused_by, fixed_by, mentioned_in, linked`

The consequence: `supports` is in a broken middle state — the reader/orderer knows it, but the validator rejects any page that uses it (`relations.supports is not a known edge type`). A user who follows the reader's list and writes `relations.supports` gets a lint failure. The two lists must be **one source of truth**.

(Two prior audits disagreed on whether `supports` "exists" precisely because they each read a different list. The validator is the gate, so the usable set is 10; the docs have been corrected to 10. This brief fixes the code so the lists can't disagree again.)

---

## Scope guard

You will:

### Task 1 — Single source of truth for relation types

- Define the canonical relation-type list **once** (e.g., export `RELATION_TYPES` from `src/retrieval/relations.ts` or a small shared module) and have BOTH `KNOWN_RELATIONS` (validator) and `SCHEMA_RELATION_ORDER` (reader) derive from it. After this, it is impossible for the validator-accepted set and the reader-ordered set to diverge.
- **Decision — drop `supports`** (resolve to the 10-type set). Rationale: nothing in the vault uses `supports`, the validator already rejects it, and adding it to the validator would expand the accepted vocabulary with no demand. Remove `supports` from `SCHEMA_RELATION_ORDER` so both lists are the same 10. If you believe `supports` SHOULD be a real edge type (add it to the validator instead), **stop and ask** — do not silently keep the divergence.
- Preserve ordering behavior: the reader's display/serialization order can stay as-is for the 10 shared types; just remove `supports` from it.

### Task 2 — Guard against future drift

- Add a unit test asserting the validator's accepted set and the reader's ordered set are **identical** (same membership). This is the regression guard that would have caught the divergence.
- Confirm `templates/schema.md` (edge-types table, now 10 with `mentions` listed) and `docs/MEMORY-FORT-SPEC.md` (relations line, already 10) match the unified list. They were corrected during the doc pass; just verify they agree with the code constant.

### Task 3 — Docs

- `docs/ROADMAP.md`: Phase 4.12 shipped 2026-05-29 — unified relation-type lists.

You will **not**:

- Add `supports` to the validator (that's the "stop and ask" path).
- Change the RelationEdge object handling (Phase 4.6) — only the type-name list.
- Reorder or rename the 10 retained types.
- Migrate any existing vault data (none uses `supports`).

---

## Repo orientation

- `src/storage/frontmatter.ts` ~L94-105 — `KNOWN_RELATIONS` (validator).
- `src/retrieval/relations.ts` ~L21-33 — `SCHEMA_RELATION_ORDER` (reader); `supports` at L23 is the divergence.
- `test/storage/frontmatter.test.ts` / `test/retrieval/*` — home for the membership-equality guard test.

---

## Acceptance contract

1. One canonical relation-type list; validator and reader both derive from it; `supports` removed (10 types).
2. A test asserts validator-set === reader-set membership.
3. schema.md + spec match the code constant (10 types).
4. Full suite + `npm run typecheck` green; build clean; `git diff --check` clean.

---

## Commit boundaries

- Task 1: `fix: single source of truth for relation types; drop divergent 'supports' (Phase 4.12 Task 1)`
- Task 2-3: `test+docs: guard relation-list parity (Phase 4.12)`

Low severity (latent — no vault data uses `supports`), but it's a genuine correctness gap and a cheap permanent fix.
