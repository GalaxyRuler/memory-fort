# Codex Prompt — Auto-Link Re-Tuning for Real-Voyage Era + Meta-Hub Exemption

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Live vault**: `C:\Users\Admin\.memory`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (`main`). Stop and ask if scope creeps past this prompt.

---

## Mission

Auto-link is **completely silent** on the live vault: `memory link-raw --plan` (default `sim=0.75 title=0.65`) finds **0 matches across 551 orphan raws** — even though real Voyage embeddings now exist and there are obvious topical relationships in the data. The orphan rate on recent captures (2026-05-30 → today) is **80–95 %**, vs the pre-regression sweet spot of 4–10 % in 2026-05-24 → 26.

The conservative defaults were correct for the era they were tuned in (commits `4.37.1` / `4.37.2`, when sidecar vectors were degenerate `[1,0,0]` stubs and "better 0 than 62 wrong" was the right call). With real Voyage 2048-dim vectors (commits `0566984` durability + `5b1aa08` perf), those thresholds are too high to ever hit. Net effect: auto-link is decorative; the graph's participation rate is stuck at 54.17 %; new captures pile up unlinked.

**Your job: re-tune for the real-Voyage era and prove the new defaults emit real, diverse, topical anchors — by reading them, not by trusting counts.** Then run a backstopped `--apply` against the backlog. Operator has been burned six times by premature "done" — *verify-before-claim* is the rule: a green test is not proof; reading the matched-raw bytes against the matched-wiki bytes is.

---

## Verified context (confirm by reading; do not trust)

- **Auto-link entrypoint.** `src/capture/auto-link.ts autoLinkRawToWiki` + the `link-raw` CLI (`src/cli/commands/link-raw.ts`). Capture-time call lives in `src/hooks/post-tool-use.ts` (gated on `auto_link.enabled`, default true).
- **Scorer state.** After `4.37.2`, `titleMatchScore` strips numeric/date tokens and uses true `supportCoverage` (no saturation cap). The embedding path uses `cosineSimilarity` against the embeddings sidecar, with the **degeneracy guard** from `4.37.1` (dim floor, all-identical detection). **Preserve all of this.**
- **Defaults today.** `src/storage/config.ts`: `auto_link.similarity_threshold = 0.75`, `title_threshold = 0.65`, `mass_collision_threshold = 0.20`. CLI exposes overrides (`--threshold`, `--title-threshold`, `--mass-collision-threshold`).
- **Write-guard intact.** Commit `a60ebe2` refuses degenerate vectors. Don't regress.
- **Mass-collision rule.** `link-raw` aborts `--apply` when `> mass_collision_threshold` of orphans map to one target — to catch the `[1,0,0]` stub catastrophe. Today this also triggers on **legitimate meta-reference hubs** (e.g. `wiki/references/mcp-servers-available.md` — every MCP-discussion raw genuinely mentions it).

---

## Phase 1 — Empirical evidence (reproduce, then expand)

Re-run on the **live keyed vault**. Paste the numbers; cite the command.

Reproduced today (2026-06-04):

| Run | sim | title | Matched | Distinct targets | Top hub % | Total scanned | Orphan |
|---|---:|---:|---:|---:|---:|---:|---:|
| default | 0.75 | 0.65 | **0** | — | — | 1746 | 551 |
| relaxed | 0.60 | 0.50 | **177** | 19 | 23.7 % (mcp-servers-available) | 1746 | 551 |
| loose | 0.50 | 0.40 | **355** | — | — | 1746 | 551 |

Sample of relaxed matches (read these against the raws — verify topical reality):

```
raw/2026-05-13/...e769dab2.md  -> mcp-servers-available (0.742) + mcp-plugin-bundled-mcp-json (0.664) + antigravity-mcp-only-ingestion (0.618)
raw/2026-05-26/...019e6606.md  -> visual-functional-enhancements-iaqar-project (0.664) + git-operations-bilingual-audit-enhancements (0.618) + projects/iaqar (0.616)
raw/2026-04-17/...a04011b8.md  -> decisions/2026-05-20-voyage-ai-for-embeddings (0.601)
```

These look like real topical clusters, not date/generic-token noise. Confirm by reading the raw bytes against the wiki bytes.

**Your task in Phase 1:**

1. Reproduce the three runs above; paste outputs and counts.
2. Generate a **score histogram** of all candidate match scores in the relaxed run (bucket: 0.55–0.60, 0.60–0.65, …, 0.95–1.00) so we can see the actual cluster band on the live data.
3. For each of **10 random matches at sim ≥ 0.60**, read the raw file and the matched wiki page and answer in one line: real / borderline / noise. This is the empirical basis for the threshold.
4. Identify the meta-reference hubs (pages that legitimately receive many mentions because they ARE the catalog/reference for a domain): at minimum `wiki/references/mcp-servers-available.md`. Find more by reading.

---

## Phase 2 — Ground (online, cite recency)

Search current best practice for: cosine-similarity threshold tuning for retrieval-grade embedding models (specifically Voyage `voyage-4-large`, 2048-dim, post-2026); ROC-style precision/recall tradeoff for entity linking; "hub" handling in entity-linking pipelines (dedicated exemption lists vs. dynamic detection). Distinguish fact from interpretation; note recency.

---

## Phase 3 — Options + trade-offs

For **each** problem, give ≥ 2 viable options with explicit trade-offs (precision, recall, complexity, risk of false-positive flood). Likely directions (evaluate, don't assume):

**Problem A — embedding threshold too high for real Voyage**

- **A1. Lower default `similarity_threshold` to ~0.60** (empirically validated band; precision still high based on the read sample).
- **A2. Adaptive threshold: `mean + k*stddev`** over the per-raw candidate scores so each raw gets its own cutoff. More complex; better recall on weak-signal raws; risk of pulling noise on diffuse raws.
- **A3. Keep 0.75 but add a *secondary* low-confidence link type** (`mentions_weak` at 0.55–0.75) that the graph health surfaces but does not count as a reasoning edge. Conservative; preserves audit trail.

**Problem B — title threshold too high (fallback path)**

- **B1. Lower `title_threshold` default to ~0.55** (matches the same precision band).
- **B2. Keep 0.65 — embedding path covers most cases now that vectors are real**.

**Problem C — mass-collision flags legitimate hubs**

- **C1. Hub exemption list** (config: `auto_link.exempt_hub_pages`) — pages listed there don't count toward the mass-collision cap. Start with `wiki/references/mcp-servers-available.md`. Document how operators add more.
- **C2. Dynamic hub detection** — if a wiki page is on the inbound side of many existing pages (degree ≥ N), treat as a hub and exempt automatically.
- **C3. Raise the cap to 30 %.** Cruder; weakens the original guard.

Recommend one option per problem with justification. **Conservatism rule:** the new defaults must STILL fail loudly on the original 4.37.1 catastrophe (degenerate embeddings → 498 raws → 3 decision pages at 1.000). Prove it with a regression fixture.

---

## Phase 4 — Implement (TDD, stay green)

- Tests first. Keep `npm run typecheck`, `npm run build`, the suite green at every commit.
- New tests:
  - Defaults: sim=0.60 / title=0.55 (or whatever you recommend) produces ≥ 100 matches on a fixture corpus with known topical clusters.
  - Hub exemption: a page in `auto_link.exempt_hub_pages` does not trip mass-collision even if it receives > threshold of matches.
  - Stub-vault regression: feed degenerate `[1,0,0]` embeddings + lowered thresholds; assert auto-link STILL refuses (degeneracy guard intact).
  - Sample-verify gate: a unit-level synthetic test that a raw with **only** date/generic tokens overlapping a candidate scores below `title_threshold` (4.37.2 fix preserved).
- Don't break: `0566984` durability, `5b1aa08` perf, `a41759c` auto-heal launcher, `a97110d` supervisor backend, `45f3e0e` spend-leak fix, `a60ebe2` write-guard.

---

## Phase 5 — Adversarial self-audit (the gate: read the bytes, not the count)

Before claiming done, prove on the **live keyed vault**:

1. **Reproduce the histogram** after threshold change. Paste it.
2. **Read 10 random matches** (`--plan` output) and assert in one line each: real / borderline / noise. **Noise rate must be ≤ 20 %** of the sample, otherwise raise the threshold and re-test. Cite the exact raw text excerpt and the exact wiki snippet you compared.
3. **Mass-collision on the live vault**: top-target hit share for the recommended threshold must be **< the configured cap unless the target is on the exempt list**. Show the distribution.
4. **Negative test on the live vault**: pick a raw the system already linked correctly (in `linked` set) and confirm the new scorer still links it.
5. **Stub-vault regression**: degeneracy guard still fails loudly on `[1,0,0]` embeddings (unit test + a manual artifact-read on a fixture).
6. **Apply on the live vault**: `memory link-raw --apply` with the recommended thresholds. Show the summary (matched, skipped, by-target distribution). Re-check `/api/graph-health` afterwards: **participation rate should rise materially** (was 54.17 %), **orphan-episodic rate should drop** (was 26.75 %), no warn/fail introduced.
7. **Perf regression guard**: warm `/api/search` still `refreshMs:0`, `rerankMs>0`. Nothing in this brief touches the search path; if numbers move, find the cause.

A green unit test is not acceptance for any of these. Paste commands + real outputs + artifact reads. If a check can't be proven, say so and stop.

---

## Constraints (hard)

- Secrets env-var only; never print/commit `VOYAGE_API_KEY`; no secret-shaped content in logs.
- No permanent deletions; archive instead. **Do not bulk-rewrite raw frontmatter** without writing a `--plan` first and reading the proposed diff for a sample.
- No live full re-embed.
- Operator-style `--apply` against the live vault is **in scope** for this brief (it's the deliverable), but you must `--plan` first, pass the sample-verify gate, then `--apply` with the mass-collision backstop armed.
- Windows + PowerShell 7. No OneDrive paths.
- Preserve all prior wins: durability, perf, launcher, supervisor, write-guard, auto-heal, spend-leak fix.

## Stop-and-ask

1. The empirical noise rate at sim=0.60 exceeds 20 % — propose the threshold band that hits ≤ 20 % and stop for approval before lowering further.
2. The hub-exemption list grows past ~5 pages — propose dynamic detection (Problem C2) instead and stop.
3. `--apply` on the live vault would touch > 250 raws — stop and ask before running.
4. New defaults regress the stub-vault degeneracy test — stop; do not ship.

## Output contract

- Phase 1 reproductions with histogram + 10-sample read-out.
- Phase 2 sources + what you took from each.
- Phase 3 options + recommendation per problem.
- Diffs/commits + test names (config defaults, exempt-hub list, regression tests).
- **Phase 5 live evidence:** `--plan` outputs, sample-verify table, `--apply` summary, before/after `/api/graph-health`, before/after `/api/search` timings.
- Residual risks + an updated operator runbook: how to tune thresholds, how to add hubs, how to re-link the backlog safely.

## Definition of done ("not silent")

- `memory link-raw --plan` at the new defaults emits matches on the live backlog with ≤ 20 % noise rate (verified by reading raws vs. wiki).
- Mass-collision backstop still fires on a degenerate stub fixture but not on legitimate meta-hubs.
- `link-raw --apply` runs against the live vault under the new defaults; `/api/graph-health` shows **participation rate up materially from 54.17 %** and **orphan-episodic rate down from 26.75 %**, no warn/fail introduced.
- All prior gains intact: durability, perf, write-guard, auto-heal, supervisor, spend-leak fix.
- Every claim above backed by a command output or artifact read in the report.
