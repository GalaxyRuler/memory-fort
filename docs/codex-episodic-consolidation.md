# Codex Implementation Brief — Episodic-to-Semantic Consolidation

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Memory Fort imports episodic memories (Codex session logs, claude-code captures, agentmemory observations) as **raw verbatim text**. The importer does no entity extraction. Result: 141 of 149 episodic memories in the live vault are **orphans** — no inbound or outbound relations — despite their bodies mentioning real decisions, projects, tools, lessons by name. The galactic graph shows the Episodic galaxy as a sparse cluster with only 8 connected nodes; the other 141 sit on the rim, unreferenced.

This brief delivers an **episodic-to-semantic consolidation pipeline**: scan every episodic observation, find mentions of existing wiki pages, and connect them. After this lands, an old Codex session that talked for 2000 lines about "Voyage AI embeddings" will surface as a real episodic node connected to `wiki/decisions/voyage-ai-for-embeddings.md` — and that decision page will show the session in its inbound list.

This closes one of the SOTA gaps we cherry-picked OUT of scope earlier (alongside spreading activation, which Codex already shipped). It's the **consolidation** half of the cognitive-memory loop — episodic memories settling into the semantic web instead of staying as isolated journal entries.

---

## Scope guard

You will:

- Build a `memory consolidate` CLI command that scans raw observations and links them to existing wiki pages
- Use **lexical + BM25 hybrid matching** (no LLM calls) — deterministic, free, leverages existing retrieval infrastructure
- Write back **relations frontmatter** (not inline wikilinks — those mutate body content and conflict with raw-observation integrity)
- Preserve every observation's body verbatim
- Be idempotent (skip already-consolidated files)
- Have `--plan` (dry-run) and `--apply` modes matching the pattern of `memory import-agentmemory` and `memory backfill`
- Write an audit log to `wiki/.audit/consolidate-{timestamp}.md`

You will **not**:

- Modify the body of any observation (no inline wikilink injection)
- Call any LLM or embedding API — this is pure lexical + BM25
- Auto-generate new wiki pages from patterns (that's a separate "crystallization" feature out of scope)
- Modify existing relations on observations that already have them
- Touch the dashboard, search pipeline, or other CLI commands beyond registering `consolidate`
- Add new heavy dependencies

If a sensible default for a matching threshold is unclear from the brief, **stop and ask**. Wrong thresholds either flood every observation with false-positive links or fail to link real ones.

---

## Repo orientation (verified before brief)

- `src/retrieval/bm25.ts` — existing BM25 tokenizer + scoring. Reusable as-is.
- `src/retrieval/corpus.ts` — `loadCorpus()` produces `SearchDocument[]` with title, body, tags, frontmatter. Reusable.
- `src/storage/frontmatter.ts` — `parseFrontmatter` / `serializeFrontmatter` for read-modify-write of observation files.
- `src/storage/atomic-write.ts` — atomic file writes (don't half-write a file mid-consolidation).
- `src/cli.ts` — register new command here.
- Live evidence: 149 episodic memories, 8 with relations, 141 orphans. After consolidation we expect 60–90% of orphans to gain at least one relation.

### Existing relations frontmatter format

Wiki pages and observations use this shape (verify against `src/retrieval/corpus.ts:readRelations`):

```yaml
relations:
  mentions:
    - wiki/decisions/voyage-ai-for-embeddings.md
    - wiki/projects/memory-fort.md
  derived_from:
    - wiki/references/karpathy-llm-wiki-pattern.md
```

Each key is a relation type (`mentions`, `references`, `derived_from`, `supersedes`, etc.). The value is an array of target relPaths. The consolidate command writes to the `mentions` relation type.

---

## Task 1 — Lexical title-and-alias matcher

### Why
The highest-precision signal: an episodic body that contains the exact title of a wiki page almost certainly references it. Build a fast string-matching index.

### Contract

`buildTitleIndex(corpus: SearchDocument[]): TitleIndex`

The index has:
- All canonical titles, lowercased and tokenized
- Optional aliases from frontmatter (`aliases: [...]` field on wiki pages — likely doesn't exist yet, treat as empty)
- A reverse map: lowercased title → wiki relPath
- Stripped: short titles (under 4 chars), pure-numeric titles, titles that are also stopwords ("test", "memory", "system" by themselves)

`findTitleMentions(body: string, index: TitleIndex): Match[]`
- Scans the body for case-insensitive exact substring matches of indexed titles
- Returns `{ relPath, title, position, confidence }` for each hit
- Confidence = `1.0` for exact title match, `0.85` for partial (e.g., "Voyage AI" matching "Voyage AI for embeddings")
- Deduplicate by relPath (one match per page even if title appears multiple times)

### Files

- New: `src/consolidate/title-index.ts`
- New: `test/consolidate/title-index.test.ts` — fixture with 10 wiki pages and 5 episodic bodies, verify exact and partial matches; verify short/numeric titles excluded

---

## Task 2 — BM25 augmentation pass

### Why
Lexical matching is high-precision but low-recall — it misses paraphrases ("the Voyage decision" instead of the full title). BM25 over the existing corpus catches those: an observation whose top-3 BM25 results all converge on the same wiki page is almost certainly about that page.

### Contract

`findBM25Mentions(body: string, corpus: SearchDocument[], opts): Match[]`
- Use existing `bm25Score` from `src/retrieval/bm25.ts`
- Score the observation body against every wiki page (NOT against other observations — only wiki/* targets)
- Return matches with `score >= threshold` (default `5.0` — tune via the fixture test)
- Cap to top-K (default 10) per observation
- Mark these with `confidence: 0.5–0.8` proportional to score above threshold

Combine with lexical matches:
- If a page is in BOTH lexical AND BM25 results → confidence = max(lex, bm25)
- If only BM25 → keep it but at the lower confidence ceiling

### Files

- New: `src/consolidate/bm25-augment.ts`
- New: `test/consolidate/bm25-augment.test.ts` — fixtures where the title doesn't appear verbatim but the topic is unmistakable

---

## Task 3 — Consolidation runner + frontmatter writer

### Why
The core glue: walk every raw observation, run both matchers, decide which targets to link, write back the relations frontmatter.

### Contract

```ts
interface ConsolidatePlan {
  observation: string;          // relPath
  currentRelations: string[];   // relPaths already in the observation's mentions
  proposedRelations: Array<{
    relPath: string;
    title: string;
    confidence: number;
    source: 'lexical' | 'bm25' | 'both';
  }>;
  willWrite: boolean;           // false if no proposed > confidence threshold OR already linked
}
```

`runConsolidate(opts: { plan: boolean; minConfidence: number; maxLinksPerObservation: number; corpusRoot: string }): Promise<ConsolidateResult>`

Rules:
- Default `minConfidence: 0.6`, `maxLinksPerObservation: 5`
- Skip observations that already have `relations.mentions` (idempotent — re-running adds nothing new on already-consolidated files)
- A `--force` flag overrides the idempotency check (re-runs everything; useful when matching rules change)
- Write `relations.mentions: [<relPaths>]` to the observation's frontmatter, sorted by confidence descending
- Body is **never** modified
- Atomic write via `atomicWrite`

Audit log written to `wiki/.audit/consolidate-{timestamp}.md`:
- Per-observation: relPath, count of new relations added, list of matched titles
- Summary: total scanned, total updated, total new edges created

### Files

- New: `src/consolidate/runner.ts`
- New: `src/cli/commands/consolidate.ts`
- Register in `src/cli.ts`
- New: `test/cli/commands/consolidate.test.ts`

---

## Task 4 — CLI wiring + integration with existing commands

### Why
The consolidate command is most useful when it runs **after** every import/backfill. Wire it into the natural workflow.

### Contract

CLI:
```
memory consolidate --plan
memory consolidate --apply
memory consolidate --apply --min-confidence 0.7
memory consolidate --apply --force      # re-link even already-linked files
```

Also: extend `memory backfill` and `memory import-agentmemory` with an optional `--consolidate-after` flag that chains a `consolidate --apply` run after the import completes. Default off (operator runs explicitly).

`memory verify` gains a new check: "X% of episodic memories have ≥1 relation". Warns if below 30%. Becomes the early-warning signal for the consolidation pipeline silently breaking later.

### Files

- Modify: `src/cli/commands/backfill.ts`, `src/cli/commands/import-agentmemory.ts` (add the flag)
- Modify: `src/cli/commands/verify.ts` (add the orphan-rate check)
- Extend existing tests

---

## Task 5 — Sanity test against the live vault

### Why
Threshold tuning is empirical. Before declaring done, run the pipeline against the user's actual vault and report the result.

### Contract

After Tasks 1–4 land and tests pass:
1. Run `memory consolidate --plan` against `~/.memory/`
2. Capture the output: how many observations get how many proposed links
3. Compare against expectations (60–90% of orphans should gain ≥1 relation)
4. If the rate is below 60%, the BM25 threshold (Task 2) is too high — drop it and re-test
5. If the rate is above 95%, the threshold may be too low (false positives) — sanity-check a sample
6. Commit the final threshold tuning as a separate small commit so the choice is auditable

Document the chosen threshold values in `docs/consolidation-thresholds.md` with the live-vault data that justified them.

---

## Execution order

1. **Task 1** (lexical) — foundation; high-precision matches first
2. **Task 2** (BM25) — augmentation; lower precision but catches paraphrases
3. **Task 3** (runner + writer) — glue; consumes both matchers
4. **Task 4** (CLI wiring) — operator surface
5. **Task 5** (live tune) — empirical validation against real data

Each task = one commit. Run `npx vitest run` between every commit.

---

## Build / test / deploy

```
npx vitest run                              # full suite — keep all tests green
npx vitest run test/consolidate             # consolidation tests only
npm run build
memory consolidate --plan                   # operator runs to preview
memory consolidate --apply                  # operator runs to apply
memory compile                              # rebuild graph cache so dashboard sees new edges
```

This brief does **not** require a VPS deploy. The consolidation runs locally; the resulting frontmatter changes ride along the next vault git push as normal.

---

## Acceptance checklist

- [ ] `memory consolidate --plan` against the live `~/.memory/` reports proposed relations for at least 60% of currently-orphan episodic observations
- [ ] `memory consolidate --apply` writes `relations.mentions` to those observations, preserves bodies verbatim, is idempotent on re-run
- [ ] Audit log written to `wiki/.audit/consolidate-{timestamp}.md`
- [ ] `memory verify` reports the orphan-rate metric; warns when above 70%
- [ ] All 700+ tests still green; new tests added per task
- [ ] No LLM calls, no new heavy dependencies
- [ ] Document chosen thresholds in `docs/consolidation-thresholds.md`
- [ ] No secrets committed, no OneDrive paths anywhere

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.

---

## Future work (out of scope for this brief)

These belong in separate briefs after consolidation lands:

1. **Reverse-relation backfill**: when an observation gains `mentions: [X]`, X gets `referenced_by: [observation]` automatically (currently the graph is one-directional in the file representation but the dashboard already computes both directions on read).
2. **Crystallization**: detect patterns across multiple episodic memories that all mention the same decisions/tools, and propose new wiki pages (lessons/crystals) that summarize the pattern.
3. **Embedding-based augmentation**: if BM25 recall plateaus, add a Voyage-embedding pass for paraphrase detection. Cost ~$0.01 per 1000 observations, low if run incrementally.
4. **Wikilink injection**: optional mode that ALSO injects `[[link]]` syntax inline in the body where the title appears. Useful for human reading but invasive to raw-observation integrity. Behind an opt-in flag.
