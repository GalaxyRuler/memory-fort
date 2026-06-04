# Codex Prompt — Wiki Reasoning-Edge Activation (Lift `participation-rate` Above 54.17%)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Live vault**: `C:\Users\Admin\.memory`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (`main`). Stop and ask if scope creeps past this prompt.

---

## Mission

`/api/graph-health graph.participation-rate` is stuck at **54.17 % (26/48 live wiki pages have ≥1 reasoning edge)** — has been for the entire arc through `bcf0c09`. Recent commits moved orphan-episodic rate (raw→wiki mentions), but **participation-rate counts wiki↔wiki reasoning edges only** (`uses`, `depends_on`, `supersedes`, `learned_from`, `derived_from`, `caused_by`, `fixed_by`, `contradicts`). The auto-link tuning won't move this metric; that was correctly flagged in the prior commit's report as a metric-contract mismatch.

**This slice is wiki reasoning-edge activation**, not more threshold tuning. The proof target is **`graph.participation-rate` movement up from 54.17 %** — measured live on `/api/graph-health`, not by unit tests alone. The work: a curation/thread-proposal pass over the ~22 isolated wiki pages, with a **sampled human-readable review before any `--apply`**.

**Metric contract is out of scope.** Do not change what `participation-rate` counts. If you find it cannot be moved without metric-contract changes for a specific page class (e.g. test fixtures, internal markers), stop and ask — propose archiving or exempting those, do not re-define the metric.

---

## Verified context (confirm by reading; do not trust)

- **Metric definition.** `src/dashboard/graph-health.ts` (search `participation-rate`): counts the share of live wiki pages on either side of at least one **reasoning** edge. Reasoning edge kinds are defined in `src/retrieval/edge-classes.ts`. Confirm both lists; cite file:line.
- **Live state.** `26/48 wiki pages participate`. Dashboard `topOffenders` (truncated to 5) lists:
  - `wiki/threads/successful-execution-homelab-tests-updates.md`
  - `wiki/threads/cognitive-graph-schema-evolution.md`
  - `wiki/preferences.md`
  - `wiki/threads/tauri-project-configuration-testing-enhancements.md`
  - `wiki/threads/memory-fort-architectural-maturity.md`
- **Outbound-isolated content pages** (operator scan of frontmatter `relations:` block — 7 found beyond `.audit/*` and `crystals/*`):
  - `wiki/decisions/2026-05-21-sentinel-marker-config-patches.md`
  - `wiki/lessons/systematic-debugging.md`
  - `wiki/preferences.md`
  - `wiki/references/karpathy-llm-wiki-pattern.md`
  - `wiki/references/mcp-servers-available.md`
  - `wiki/references/section-patch-fixture.md` (likely test fixture)
  - `wiki/references/fork-smoke-marker-codex-fork-smoke-…md` (likely test marker)
- **Existing tooling.** `src/cli/commands/thread.ts` (`memory thread propose | apply | promote`), `src/cli/commands/discover-threads.ts`, `src/cli/commands/consolidate.ts`, `src/cli/commands/curate.ts`, `src/cli/commands/entity.ts` (dedup). Confirm what each does and which ones write reasoning edges (vs. mentions/wikilinks).
- **Auto-link writes `mentions` only.** That's by design — reasoning edges are a curation responsibility, not capture-time.

---

## Phase 1 — Enumerate the full 22 (not just dashboard's truncated 5) and classify

Output a complete classification table:

```
path | category | inbound-degree | outbound-degree | classification | rationale
```

- **inbound/outbound degree** = count of reasoning edges in each direction (not `mentions`/`wikilinks`).
- **classification** must be exactly one of:
  - `link-candidate` — page has obvious topical connections to existing wiki content; reasoning edges should be added by curation.
  - `thread-candidate` — page should aggregate clusters of raws/decisions/lessons into a narrative thread (existing `memory thread propose` path).
  - `genuine-standalone` — boilerplate (e.g. `preferences.md`) or meta-reference (`mcp-servers-available.md`) that legitimately has no reasoning edges.
  - `test-fixture` — `section-patch-fixture.md`, `fork-smoke-marker-…`, etc. Should be archived or excluded from the metric denominator.
  - `archive-candidate` — stale/superseded page that should move to `wiki/.history/` or `.archive/`.
- **rationale** must cite the page's title and frontmatter (`type`, `lifecycle`, `tags`) — not memory.

Read each page. Don't classify from filenames alone.

---

## Phase 2 — Ground (online, cite recency)

Search current best practice for: knowledge-graph curation passes over isolated nodes; thread/cluster proposal as a way to densify a sparse graph; treating test fixtures and meta-reference pages in graph quality metrics (exempt vs archive vs leave). Distinguish fact from interpretation; note recency.

---

## Phase 3 — Options + trade-offs

For **each** classification bucket, propose ≥ 2 viable activation options with explicit trade-offs (recall, precision, false-positive risk, reversibility). Likely directions — evaluate, don't assume:

**A — `link-candidate` pages**
- A1. **LLM-driven curate-merge**: use existing `memory curate <page>` to propose `relations:` additions; operator sample-reviews before merge.
- A2. **Embedding-similarity propose**: compute cosine similarity of each isolated page's body against all other wiki pages; propose top-K above a threshold as `learned_from` or `depends_on` candidates. Human-readable diff before apply.
- A3. **Manual targeted edits**: small set; just write the relations directly per page in a single commit.

**B — `thread-candidate` pages**
- B1. **Use existing `memory thread propose --apply`**: extends current pipeline; lowest blast radius.
- B2. **Use `memory discover-threads`** for cluster detection if it surfaces these pages.

**C — `genuine-standalone` pages**
- C1. **Exempt from `participation-rate`** denominator via a new `graph.participation_rate.exempt_pages` config (parallel to `graph_health.exempt_hub_pages` / `auto_link.exempt_hub_pages`). The metric still tracks 26/(48-N).
- C2. **Leave as-is**; accept the metric ceiling. Document which pages are deliberately edge-free.

**D — `test-fixture` / `archive-candidate` pages**
- D1. **Move to `.archive/` or `wiki/.history/`** with a one-line note. They never should have been counted.
- D2. **Frontmatter `lifecycle: archived`** + dashboard filter. Same effect, lighter touch.

Recommend one option per bucket. **Conservatism rule:** any LLM-proposed reasoning edge MUST go through a sample-review gate before `--apply`. Better to land 8 honest edges than 22 of which 6 are wrong.

---

## Phase 4 — Implement (TDD, stay green)

- Tests first. Keep `npm run typecheck`, `npm run build`, the suite green at every commit.
- Tests to add (depending on chosen options):
  - Embedding-propose: a fixture with a known isolated page → top-K candidates returned, threshold respected, no proposal when no candidates clear.
  - Exempt-from-participation: setting `graph.participation_rate.exempt_pages = ["wiki/preferences.md"]` removes that page from denominator without changing numerator semantics.
  - Archive flow: moving a page to `.archive/` drops it from the live wiki count.
- Reuse existing pipelines (`thread propose`, `curate`, `consolidate`) — do not duplicate.
- Don't break: `0566984` durability, `5b1aa08` perf, `a41759c` auto-heal + launcher, `a97110d` supervisor, `45f3e0e` spend-leak fix, `d16a4fb` clickable launcher, `bcf0c09` auto-link tuning, `a60ebe2` write-guard.

---

## Phase 5 — Adversarial self-audit (the gate: read the bytes + live metric)

Before claiming done, prove on the **live keyed vault**:

1. **Phase 1 classification table** complete for all 22 isolated pages.
2. **Sampled human-readable review BEFORE apply.** Pick **at least 5 proposed reasoning edges** (across buckets) and paste:
   - the source page's title + the relevant body excerpt,
   - the target page's title + the relevant body excerpt,
   - your one-line judgment: real / borderline / noise.
   - **Noise rate must be ≤ 20 %** of the sample, else raise the proposal threshold or restrict the bucket.
3. **Apply** the chosen activations.
4. **Re-read `/api/graph-health`**:
   - `graph.participation-rate` value **must rise** from 54.17 %. Paste before/after.
   - `graph.orphan-episodic` not regressed.
   - `graph.duplicate-entities`, `graph.contradiction-coverage`, `graph.hub-overload` unchanged or improved.
   - Overall status still `pass`.
5. **`/api/search` perf untouched** — warm `refreshMs:0`, `rerankMs>0`, total under a few seconds.
6. **Archive/exempt actions** (if used): paste the before/after wiki page count + the diff of pages moved.

A green unit test is not acceptance. Paste commands + real artifact reads. If a check cannot be proven, say so and stop.

---

## Constraints (hard)

- Secrets env-var only; never print/commit `VOYAGE_API_KEY`; no secret-shaped content in logs.
- **No permanent deletions.** Archive (`wiki/.history/` or `.archive/`) instead. Operator can restore.
- No metric-contract change to `participation-rate` semantics. If a bucket can't be moved without one, stop and ask.
- No live full re-embed.
- `--apply` is in scope but **only after sample-review**. Stop and ask if proposed edits exceed **15 pages** (the 22 minus the genuine-standalone subset).
- Windows + PowerShell 7. No OneDrive paths.
- Preserve all prior wins (the 7 commits above).

## Stop-and-ask

1. Sample noise rate at the proposed threshold > 20 % → propose a stricter band before lowering.
2. A bucket's only viable activation is a metric-contract change → stop; that's a separate decision.
3. `--apply` would touch > 15 pages → stop and confirm.
4. Existing `thread propose` / `curate` pipelines need non-trivial modification → stop; that's a separate brief.

## Output contract

- Phase 1 full classification table for all 22 isolated pages (file:line citations).
- Phase 2 sources + what you took from each.
- Phase 3 options + recommendation per bucket.
- Diffs/commits + test names.
- **Phase 5 live evidence**: sample-review table (≥ 5 proposed edges with bytes), `--apply` summary, before/after `/api/graph-health` participation-rate + supporting metrics, before/after `/api/search` timings.
- Residual risks + an updated operator runbook: how to curate further isolated pages, how to add to the exempt list, how to roll back a misapplied edge.

## Definition of done ("graph activating")

- All 22 isolated pages classified with rationale.
- Sample-review noise ≤ 20 % at the chosen proposal threshold.
- `--apply` runs; **`graph.participation-rate` rises measurably** from 54.17 % (e.g. ≥ 60 %), or a clearly justified subset moves and the rest are honestly exempted/archived.
- All prior gains intact: durability, perf, auto-heal, supervisor, write-guard, auto-link tuning, spend-leak fix.
- Every claim above backed by a command output or artifact read in the report.
