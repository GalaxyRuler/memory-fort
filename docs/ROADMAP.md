# Memory Fort Roadmap

This document is the single source of truth for what's next in Memory Fort. It's organized into phases by dependency, not by calendar date. Each phase has a clear goal, the briefs that compose it, the gate that decides when to move to the next phase, and the success criteria for the phase as a whole.

The roadmap was assembled from two independent research passes (the "Bastion Spine" research and the "Constellation Graph" research), both of which converged on the same overall architecture. The phases below preserve the convergent ideas, defer the speculative ones, and explicitly drop the ones inappropriate for a single-user system.

## Sequencing principles

1. **Foundation before consumers.** Data-model changes ship before code that reads them.
2. **Measure before optimize.** Observability precedes targeted optimization.
3. **Smallest reversible step.** Each brief is one PR, one concern, with one commit per task.
4. **Evidence-driven prioritization.** Later phases depend on what earlier measurement reveals.
5. **User-visible payoff per phase.** No phase that's 6 months of plumbing with nothing visible.
6. **Risk-adjusted.** High-risk architectural changes only after the foundation is solid.
7. **Single-user reality.** Multi-agent governance, ABAC, and W3C PROV stay deferred until there's a second human writing to the vault.

---

## Status overview

| Phase | Theme | Status |
|---|---|---|
| 0 | Operational stability + episodic consolidation | Complete |
| 1 | Trust signals foundation | In progress (Brief B drafted) |
| 2 | Observability — graph cohesion metrics | Drafting next |
| 3 | Targeted quality fixes — driven by Phase 2 data | Pending Phase 2 evidence |
| 4 | Richer memory kinds | Planned |
| 5 | Deferred — re-evaluate when evidence demands | Deferred |

---

## Phase 0 — Operational stability + episodic consolidation (complete)

**Goal:** Make the system observable, vault-correct on deploy, and stop the episodic-orphan problem.

**Shipped:**
- Health monitoring brief (`docs/codex-health-monitoring.md`, commits `b737f49..e4be704`) — `/api/health`, HealthBadge, scheduled verify, auto-verify after install/connect
- Episodic consolidation brief (`docs/codex-episodic-consolidation.md`, commits `33cf417..9e8916a`) — title matcher + BM25 augmentation + frontmatter writer + CLI wiring + threshold tuning. 1084 observations linked, 1285 edges, 99% coverage
- Role-aware verify brief (`docs/codex-verify-role-awareness.md`, commits `bd196c5..e6a6f9c`) — operator vs server roles, `/api/health?role=`, badge no longer permanently red on VPS
- VPS correctness brief (`docs/codex-verify-vps-correctness.md`, commits `6685269..698d937`) — vaultRoot plumbed through `runVerify`, `detectRole()` simplified, `install-vps` writes env vars to systemd
- Typed temporal edges brief (`docs/codex-typed-temporal-edges.md`, commits `f1d0fdd..a51763d`) — `readRelations()` accepts rich objects with `target/confidence/valid_from/valid_to/superseded_by`, schema doc 1.1, per-edge-type canvas rendering

**Phase 0 success criteria (met):**
- Live VPS dashboard reports overallStatus=pass on `/api/health?deep=true`
- Episodic relation coverage ≥ 90% (currently 99%)
- Verify checks correctly distinguish operator from server concerns
- Edge schema supports typed relations with temporal validity

---

## Phase 1 — Trust signals foundation

**Goal:** Every memory carries enough structured metadata for trust-aware retrieval and observability. Replace the scalar `confidence: 0.8` with a vector. Add an orthogonal `lifecycle` axis.

**Briefs:**
- Brief B — Confidence vector + lifecycle states (`docs/codex-confidence-vector-lifecycle.md`, commit `c47efda`) — drafted, ready to hand to Codex

**Why this is Phase 1 and not later:** Brief B is the data-model change that everything downstream wants to read. Phase 2's metrics dashboard becomes much more useful once it can chart validation status and lifecycle distribution; Phase 4's prospective and event-segmented memory types depend on the lifecycle field existing.

**Dependencies:** Phase 0 only.

**Phase 1 success criteria:**
- `Frontmatter.confidence` accepts both `number` and `ConfidenceVector` without breaking any existing page
- `Frontmatter.lifecycle` exists with nine states; `getLifecycle()` auto-detects sensible defaults for legacy pages
- Retrieval scoring (`metadata-score.ts`) consults lifecycle and validation alongside the existing status
- Inspector renders the vector decomposed when present
- New `freshness.staleness` verify check surfaces canonical-but-rotting memories
- All ~772 existing tests pass; behavior on scalar-confidence pages is byte-identical to today

**Gate to Phase 2:** Brief B shipped, deployed to VPS, badge stays green.

---

## Phase 2 — Observability (graph cohesion metrics)

**Goal:** Make the invisible visible. We currently know episodic-orphan rate is 1%, but we don't know our duplicate entity rate, edge-type entropy, hub overload, provenance coverage, or any of the other twelve health metrics named in the research. Phase 2 surfaces them so Phase 3 can be evidence-driven instead of opinion-driven.

**Brief to draft:** Graph Cohesion Metrics Dashboard.

**Scope:**
- New endpoint `/api/graph-health` returns a `GraphHealthReport` with the twelve metrics, each as `{ value, threshold, status: pass | warn | fail, offendingRecords: top5 }`
- New "Graph Health" panel on the Overview page renders metrics as cards sorted worst-first
- Each metric clickable → expanded view showing the offending records (top 5 likely-duplicate entity pairs, top 5 over-degree hubs, top 5 oldest stale canonicals, etc.)
- New verify check `graph.cohesion` aggregates the twelve into a single pass/warn/fail signal
- Pure observability — no automatic remediation

**Twelve metrics with feasibility per current code:**

| Metric | How | Effort | Notes |
|---|---|---|---|
| Orphan episodic rate | Already computed | Trivial | Surface existing value |
| Duplicate entity candidates | Title/alias clustering | Medium | Needs simple alias logic |
| Edge-type entropy | Shannon entropy over types | Trivial | Brief A made this computable |
| Cross-galaxy edge ratio | Edges where source/target galaxies differ | Trivial | |
| Hub overload | Top-K nodes by degree | Trivial | |
| Temporal edge coverage | `edges_with_valid_from / edges` | Trivial | Brief A made this computable |
| Provenance coverage | `nodes_with_imported_from / nodes` | Trivial | |
| Confidence coverage | `nodes_with_confidence / nodes` | Trivial | |
| Contradiction coverage | Count `contradicts` edges | Trivial | Brief A made this computable |
| Narrative thread coverage | Episodes assigned to threads | Deferred to Phase 4 | No threads model yet |
| Project subgraph density | Per-project intra-edges / possible | Medium | |
| Agent write attribution | `writes_with_agent_id / writes` | Already known | |

Eleven of twelve are computable today. The twelfth (narrative thread coverage) ships as "N/A — pending narrative threads" until Phase 4.

**Dependencies:** Phase 1 (so the dashboard can also chart validation and lifecycle distribution).

**Phase 2 success criteria:**
- Eleven metrics live on `/api/graph-health` and on the Overview panel
- Three metrics surface real warn/fail signals on the live VPS vault (validates the thresholds aren't trivially passing)
- The `graph.cohesion` verify check turns up in `/api/health` reports
- Click-through to offending records works for at least three metrics

**Gate to Phase 3:** Dashboard live, real signals visible, the three reddest metrics identified.

---

## Phase 3 — Targeted quality fixes (driven by Phase 2 data)

**Goal:** Fix the worst metric first. Don't pre-commit to which fix — let Phase 2 tell us.

This phase is intentionally **not pre-sequenced**. The order depends on which metric is reddest after Phase 2. Each candidate below maps a metric to its remediation brief.

| Phase 2 metric in red | Brief to draft | Scope |
|---|---|---|
| Duplicate entity candidates | Canonical entity registry | Promote entity-mention strings into canonical records with aliases. Wiki pages become entity records themselves (no parallel `entities/` directory). Consolidation matcher uses the alias table. |
| Edge-type entropy too low (most edges are `mentions`) | Typed-edge proposing in consolidation | Extend the BM25 + lexical matchers to classify each match into a probable type (`derived_from` for raw → wiki, `supports`/`contradicts` when language signals it). Current consolidation writes `mentions` for everything. |
| Cross-galaxy edge ratio dominates | Edge audit + manual re-typing pass | Surface the cross-galaxy edges in the dashboard with a "review & re-type" workflow. One-time cleanup. |
| Hub overload | Graph compaction | Auto-propose intermediate nodes when a hub gets too many edges (decision page from many episodes, procedural memory from repeated workflows). |
| Provenance coverage low | Provenance backfill | Sweep wiki pages missing `imported_from` or `source` fields. CLI command `memory backfill-provenance --plan/--apply`. |
| Stale canonical rate climbing (from Brief B's check) | Validation workflow in dashboard | "Validate this memory" button on inspector that flips `validation: user` and stamps `freshness: <today>`. |
| Retrieval noise (out-of-scope results) | Retrieval intent classifier | Classify query into one of seven intents (`decision/procedure/episodic/preference/current-truth/code-context/why`). Adapt RRF weights per intent. |

**Dependencies:** Phase 2.

**Phase 3 success criteria:** Whatever metric was reddest at end of Phase 2 moves from red to green. Each shipped brief addresses one metric. Stop when no metric is red.

**Gate to Phase 4:** No graph-health metric in fail state. Warn states acceptable.

---

## Phase 4 — Richer memory kinds

**Goal:** Expand beyond the current four cognitive types. Add memory kinds the system currently has nowhere to put.

**Briefs:**
1. **Prospective memory + event segmentation** (the Brief C we previously roadmapped). New `prospective` kind for pending obligations with `due:`, `triggers:`, `expires:`. Session capture splits on goal/entity/tool boundaries instead of monolithic per-session files. Adds `wiki/prospective/` directory.
2. **Narrative threads.** Explicit thread records connecting episodes, decisions, open questions. Enables the twelfth health metric from Phase 2. Auto-thread proposing is shipped as the CLI-only propose -> promote workflow, with LLM drafts isolated under `wiki/threads-proposed/` until operator validation.
3. **Procedural extraction.** Shipped 2026-05-28. Detects repeated successful command workflows across raw observations, drafts review-gated procedure pages under `wiki/procedures-proposed/`, and promotes validated keepers to `wiki/procedures/`.
4. **Query intent classifier.** Shipped 2026-05-28. Classifies retrieval queries into decision, procedure, episodic, preference, current-truth, code-context, or open-ended so search can adapt stream weights per question.
5. **LLM output grounding.** Shipped 2026-05-28. Auto-thread and auto-procedure prompts now include real candidate wiki paths; post-process filters remove invented wiki references and unsupported procedure commands before draft files are written. This closes the Phase 4.3 LLM-consumer hardening sequence.
6. **LLM debug logging.** Shipped 2026-05-28. Strict opt-in plaintext prompt/response logs are available through `MEMORY_LLM_DEBUG_LOG=1`; parser failures now retain specific rejection reasons and optional hashes for diagnostics.
7. **Prompt field clarification.** Shipped 2026-05-28. Auto-propose prompts now keep candidate wiki paths scoped to relation context, and post-process grounding strips bare `wiki/...` or `raw/...` leaks from prose fields while auditing `prosePathLeaks`.
8. **Overview redesign UX fixes.** Shipped 2026-05-28. Overview graph health is collapsed by default with persisted expansion, `/memory/health` provides the drill-down view, status/errors link to filtered audit entries, provider settings show real controls immediately, high-volume browse pages load in 50-row increments, and wiki browse groups pages by memory category.

**Dependencies:** Phase 3. (Brief C explicitly depends on lifecycle states from Phase 1; narrative threads are most useful once we have the entity registry from Phase 3 if duplicate metric drove that.)

**Phase 4 success criteria:**
- Prospective memories captured for in-flight commitments
- Sessions split into segments smaller than today's monolithic files
- At least one narrative thread exists tying together a multi-week project
- Procedural extraction has surfaced at least one repeated workflow for promotion

**Gate to Phase 5:** All four memory kinds (core/semantic/episodic/procedural) plus prospective have active populated examples in the vault.

---

## Phase 5 — Deferred until evidence

These are the ideas that surfaced in research but should NOT be implemented yet. Listed so they're not forgotten and so we have a clear bar for re-evaluation.

| Idea | Defer until |
|---|---|
| SQLite ledger as derived index | Markdown query performance is the bottleneck (currently it isn't — 1097 raw + 165 wiki is easily in-memory) |
| Edge confidence formula calibration | We have ≥ 1000 labeled accept/reject retrieval events to train the weights |
| Multi-agent memory protocol (16 ops) | A second human starts writing to the vault |
| ABAC / Zero Trust / privacy classes | Sensitive data is captured (today nothing rises to that bar) |
| W3C PROV-style provenance | Audit requirements demand entity/activity/agent records (today the lighter `source` fields are sufficient) |
| Webhook notifications (Slack/Discord) | Two missed failure incidents motivate it |
| Self-healing from the badge | Three recurring failures point at the same fixable root cause |
| Embedding-based augmentation for paraphrase detection in consolidation | BM25 recall plateaus below 80% |

---

## Operational follow-ups (separate from the phase roadmap)

These are small, one-off maintenance items that don't fit the phased model. Pick them off as they become annoying.

| Item | Source | Cost | Trigger to act |
|---|---|---|---|
| Re-run `memory install-vps` on live VPS | Phase 0 leftover | 5 min | When you want the operator `role.conf` drop-in to become redundant |
| Fix 2 parallelism-induced test flakes (`longmemeval-integration.test.ts`, `install-vscode.test.ts`) | Brief A verification | 1–2 hours | When you want a green CI without `--no-file-parallelism` |
| Sparse VPS embeddings (12 wiki / 89 raw) | Phase 0 diagnosis | One-shot `memory refresh-embeddings` invocation | Whenever; the search degraded mode still works |
| Post-receive hook auto-deploys dashboard bundle | VPS correctness future-work | Half day | When the manual scp dance becomes annoying enough |
| Document `MEMORY_ROOT` / `MEMORY_ROLE` in CLI help | VPS correctness future-work | 15 min | Whenever a brief touches CLI help anyway |
| `memory verify --remote root@host:/path` | VPS correctness future-work | Half day | When cross-machine sanity checks become useful |

---

## Decision log (record of significant choices)

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-27 | Markdown stays canonical; SQLite deferred | No query performance bottleneck demonstrated; markdown gives git-diff / hand-edit / grep affordances that a DB would lose |
| 2026-05-27 | Multi-agent governance deferred (no protocol, no ABAC) | Single-user system; protocol becomes useful only with a second human |
| 2026-05-27 | `lifecycle` is a NEW field orthogonal to `status` (not an expanded `status` enum) | Backwards-compat is perfect; the two concerns (visibility vs journey) genuinely are orthogonal |
| 2026-05-27 | Entity registry uses existing wiki pages as entity records (not a parallel `entities/` directory) | One source of truth; avoid parallel hierarchy churn |
| 2026-05-27 | Edge confidence stays rule-based until ≥ 1000 labeled events | Premature calibration overfits; rule-based is honest about what we know |
| 2026-05-27 | Measurement (Phase 2) precedes targeted optimization (Phase 3) | Avoid guessing the next bottleneck |
| 2026-05-27 | Embedder providers are abstracted before Settings editability | Phase 4.3.A makes Voyage, OpenAI, and Ollama selectable from config/CLI first; LLM providers and Settings writes remain the next briefs |
| 2026-05-28 | Auto-thread proposing keeps narrative coverage honest | LLM drafts land in `wiki/threads-proposed/` and only count toward coverage after `memory thread promote` moves them to `wiki/threads/` |
| 2026-05-28 | Procedural extraction uses the same review gate as threads | LLM drafts land in `wiki/procedures-proposed/`; only `memory procedure promote` moves reviewed workflows into canonical procedural memory |
| 2026-05-28 | Query intent classification ships retrieval adaptation | Search now applies heuristic-first intent labels and per-intent stream weights, with `open-ended` preserving uniform baseline retrieval |
| 2026-05-28 | LLM proposal outputs require grounding | Auto-propose consumers get candidate wiki paths in prompt and strip unresolved structural references before draft write; audit summary surfaces strip rates |
| 2026-05-28 | Plaintext LLM debug logging is strict opt-in | Hashed audit rows stay canonical; sensitive prompt/response files are written only for `MEMORY_LLM_DEBUG_LOG=1` and ignored by runtime vault git |
| 2026-05-28 | Candidate paths are relation context, not prose | Thread/procedure prompts forbid path strings in prose fields; bare path leaks are stripped and counted separately from unresolved reference stripping |
| 2026-05-28 | Overview is a summary, health is a drill-down | Graph-health cards stay collapsed on Overview and navigate to `/memory/health#<metric>`; detailed offender lists live on the dedicated route to keep the first screen scannable |

---

## How to use this document

- **Starting a new brief:** read the Phase the brief belongs to; check its dependencies are met; reuse the structure of recent briefs in `docs/codex-*.md`
- **Picking what's next:** the topmost in-progress or pending phase is the answer. Within Phase 3, the choice is driven by Phase 2 data, not by reading this list top-down
- **Adding a new idea:** put it in Phase 5 (deferred) with a concrete trigger for when to act, OR in the operational follow-ups table if it's a one-off maintenance item
- **Recording a decision:** append to the decision log, don't edit history
