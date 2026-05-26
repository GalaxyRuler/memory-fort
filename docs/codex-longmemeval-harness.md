# Codex Implementation Brief — LongMemEval-S Retrieval Benchmark Harness

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Memory Fort has historically claimed `R@5 = 95.2%` on the **LongMemEval-S** dataset but there's no harness to actually run that benchmark, regress-check it, or compare configurations. Recent retrieval changes (spreading-activation stream, cross-agent canonicalization, agentmemory migration noise) could have moved that number in either direction and we'd never know.

Add a `memory eval longmemeval` CLI command that runs the benchmark end-to-end against a configurable vault, produces a structured report, and fails CI if Recall@K regresses below a baseline threshold. The harness should be runnable on-demand by a developer, on a schedule by a cron, and inside a test runner.

---

## Scope guard

You will:

- Wire a `memory eval longmemeval` CLI command with `--k <n>`, `--corpus <path>`, `--baseline <r@5>`, `--output <path>`, `--limit <n>`, `--verbose` options
- Add a dataset loader for LongMemEval-S that reads from a downloaded JSONL file (do NOT auto-download; the user runs a separate `memory eval download` once)
- Build a small evaluation runner module that exercises the existing `runSearch()` from `src/retrieval/search.ts` against each question and scores per-question Recall@K
- Output a structured report (JSON + human-readable markdown) under `wiki/.audit/longmemeval-{timestamp}.{json,md}`
- Exit non-zero if Recall@5 is below `--baseline` (default 0.92)
- Add a vitest integration test that runs the harness against a tiny fixture dataset (10 questions) to keep the test fast and offline

You will **not**:

- Modify the search pipeline (`src/retrieval/search.ts`) or any ranking logic
- Add new retrieval streams or change RRF parameters
- Download datasets at command time (only on explicit `memory eval download`)
- Run any LLM-as-a-judge style scoring; this is **pure retrieval Recall@K** measurement
- Push the dataset itself to the repo (large; add to `.gitignore`)
- Touch the dashboard or any UI route
- Introduce new dependencies beyond `node:fs`, `node:crypto`, `zod` (already in deps)

If the dataset's true positive structure doesn't fit cleanly into `runSearch()`'s response shape, **stop and ask** rather than improvising scoring rules.

---

## Repo orientation (verified before brief)

- `src/retrieval/search.ts` — `runSearch({ query, scope, k })` returns `{ results: SearchResult[], timings, hyde, ... }`. Each `SearchResult` has `path`, `title`, `snippet`, `score`, `source` (which stream contributed), `kind`.
- `src/retrieval/corpus.ts` — `SearchDocument` is the indexed page. `loadCorpus()` reads the vault. `relPath` field uniquely identifies each document.
- `src/cli.ts` — top-level command router. Add `eval` as a new top-level subcommand with `longmemeval` / `download` nested.
- `wiki/.audit/` — used by other commands (`memory import-agentmemory`, etc.) for run logs. Reuse the convention.
- Test files live under `test/`; vitest is configured via `vitest.config.ts`.

---

## Task 1 — Dataset acquisition (separate command)

### Why
The user runs `memory eval download` once to fetch LongMemEval-S into a local cache (`~/.memory/datasets/longmemeval-s/`). This is separate from running the eval so CI doesn't accidentally pull megabytes on every test.

### Contract

- New command `memory eval download [--dataset longmemeval-s] [--cache <dir>]`
  - Default `--cache ~/.memory/datasets/`
  - Downloads the LongMemEval-S evaluation set from its canonical source. The dataset is published by the LongMemEval paper authors (Wu et al. 2024, arXiv 2410.10813); fetch from the official HuggingFace repository `xiaowu0162/longmemeval` (verify URL at implementation time and use the redistributable license-compatible file).
  - Validates SHA-256 against a pinned hash baked into the source code (so future runs don't silently pick up upstream changes)
  - Extracts/normalizes to JSONL with one question per line. Each line has `question_id`, `question`, `expected_evidence_ids: string[]`, `category`, `timestamp` — adjust field names to match the upstream schema but stay consistent
  - Writes `~/.memory/datasets/longmemeval-s/questions.jsonl` and `~/.memory/datasets/longmemeval-s/manifest.json` (containing hash, version, download timestamp, source URL)
- Idempotent: re-running checks the manifest and skips if hash matches
- Fail-safe: if upstream URL is unreachable, print a clear instruction for manual download and exit 1

### Files

- New: `src/eval/longmemeval/download.ts`
- New: `src/eval/longmemeval/manifest.ts` (manifest read/write + hash verification)
- Reference from `src/cli/commands/eval.ts` (command router for `eval` subcommand)
- Add `~/.memory/datasets/` to `.gitignore` if not already

### Tests

- `test/eval/longmemeval-download.test.ts`:
  - Mock the network layer; verify request URL, hash check, manifest write
  - Test idempotency: second call with matching manifest exits without re-downloading
  - Test failure path: corrupt download (hash mismatch) deletes partial file and exits 1

---

## Task 2 — Evaluation runner

### Why
The core of the brief: given a loaded dataset and a vault, run search for every question, score Recall@K, output a report.

### Contract

`runLongMemEval(opts)` is a pure async function that:

```ts
interface RunLongMemEvalOptions {
  datasetPath: string;        // path to questions.jsonl
  vaultRoot: string;          // path to the vault to search against
  k?: number[];               // K values to measure recall at (default [1, 5, 10])
  limit?: number;             // run only the first N questions (for fast tests)
  searchConfig?: Partial<SearchConfig>; // override RRF weights, embedding provider, etc.
}

interface LongMemEvalReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  vaultRoot: string;
  datasetVersion: string;     // from manifest
  questionCount: number;
  recall: Record<number, number>;   // { 1: 0.78, 5: 0.95, 10: 0.97 }
  meanLatencyMs: number;
  p95LatencyMs: number;
  perQuestion: Array<{
    questionId: string;
    question: string;
    expected: string[];           // expected evidence paths
    retrieved: string[];          // actual top-K paths
    hits: Record<number, boolean>; // { 1: false, 5: true, 10: true }
    latencyMs: number;
  }>;
}
```

For each question:
1. Call `runSearch({ query: question, scope: 'all', k: max(k) })`
2. Compare `results[].path` against `expected_evidence_ids[]` for each K threshold
3. Record per-K hit (any expected ∈ top-K → hit)
4. Track latency

### Scoring rule

`Recall@K = (questions where at least one expected_evidence ∈ top-K results) / total_questions`

This is the standard retrieval-recall definition. Do **not** implement Mean Reciprocal Rank, NDCG, or LLM-as-judge — out of scope.

### Files

- New: `src/eval/longmemeval/runner.ts`
- New: `src/eval/longmemeval/types.ts` (the report + question shapes)
- New: `src/eval/longmemeval/scoring.ts` (pure recall@K function, easy to unit-test)
- Reference: `src/retrieval/search.ts:runSearch`

### Tests

- `test/eval/longmemeval-scoring.test.ts` — recall@K math against fixed inputs (empty results, all hits, partial hits, edge cases)
- `test/eval/longmemeval-runner.test.ts` — mock `runSearch` to return scripted results; verify report shape, latency tracking, per-question hit recording

---

## Task 3 — CLI wiring and report output

### Why
Make the runner ergonomic from the command line and CI.

### Contract

`memory eval longmemeval [options]`:

```
Options:
  --corpus <path>           Vault root (default: ~/.memory)
  --dataset <path>          Path to questions.jsonl (default: ~/.memory/datasets/longmemeval-s/questions.jsonl)
  --k <list>                Comma-separated K values (default: 1,5,10)
  --limit <n>               Stop after N questions (for fast iteration)
  --baseline <r@5>          Fail with exit 1 if Recall@5 below this (default: 0.92)
  --output <path>           Write JSON report here (default: wiki/.audit/longmemeval-{ts}.json)
  --markdown <path>         Also write a markdown summary here (default: same path with .md extension)
  --verbose                 Print per-question hits as they run
```

Output behavior:
- Always print a one-line summary to stdout: `LongMemEval-S | R@1=0.78 | R@5=0.95 | R@10=0.97 | mean=124ms | p95=380ms | n=500`
- JSON report → file specified by `--output`
- Markdown report → `--markdown` path (same content as JSON but formatted as a table + question-by-question breakdown)
- If `--baseline` exceeded: exit 0
- If `--baseline` failed: print red error to stderr explaining which K dropped, exit 1

### Markdown report format

```markdown
# LongMemEval-S Evaluation — 2026-05-26T01:30:00Z

| Metric | Value |
|---|---|
| Questions | 500 |
| R@1 | 0.78 |
| R@5 | 0.95 |
| R@10 | 0.97 |
| Mean latency | 124ms |
| P95 latency | 380ms |
| Duration | 62.4s |
| Dataset version | hash:abcd1234 |
| Vault root | /home/user/.memory |

## Failures (R@5 misses, 25 total)

- [q-014] "When did the user mention the Postgres decision?"
  - Expected: wiki/decisions/postgres-for-state.md
  - Retrieved: [wiki/decisions/jsonl-for-state.md, wiki/lessons/state-storage-tradeoffs.md, ...]

...
```

### Files

- New: `src/cli/commands/eval.ts` (subcommand router)
- New: `src/cli/commands/eval-longmemeval.ts` (the actual command body)
- New: `src/eval/longmemeval/report-markdown.ts` (markdown formatter)
- Modify: `src/cli.ts` to register `eval` as a top-level command

### Tests

- `test/cli/commands/eval-longmemeval.test.ts` — command flag parsing, default values, exit codes
- `test/eval/longmemeval-report-markdown.test.ts` — markdown output shape

---

## Task 4 — Vitest integration test against fixture

### Why
The full LongMemEval-S dataset is too large/slow to run on every PR. A fixture-driven integration test proves the pipeline works without network or large files.

### Contract

- New: `test/fixtures/longmemeval-tiny/questions.jsonl` — 10 hand-authored questions with known evidence paths. The evidence paths must point at fixtures already in `test/fixtures/vault/` (or a small fixture vault you create alongside).
- New: `test/eval/longmemeval-integration.test.ts` — loads the tiny fixture, runs the full pipeline (real `runSearch` against fixture vault), asserts:
  - Report shape matches `LongMemEval-S` interface
  - Recall@5 is above 0.6 on this tiny set (sanity floor, not the real benchmark)
  - Latency tracking populated
  - Markdown output renders without crashing

### Test data

Make the 10 fixture questions span:
- Single-hop retrieval (1 question)
- Multi-hop / multi-doc evidence (1)
- Temporal queries (1)
- Negation / contradiction cases (1)
- Misc clear-cut single-answer cases (6)

This isn't proving production quality — it's smoke-testing the harness end to end.

---

## Execution order

1. **Task 1** — dataset download command + manifest. Lowest-risk, independent.
2. **Task 2** — runner + scoring. Pure logic, fully unit-testable.
3. **Task 3** — CLI + reports. Glues 1 and 2 together.
4. **Task 4** — integration test against fixtures. Ships confidence.
5. (Optional follow-up, separate brief) Run the real benchmark against the live vault, commit the resulting baseline report to `wiki/.audit/longmemeval-baseline.md`, and use that as the new `--baseline` default.

Each task gets one commit. Run `npx vitest run` between every commit.

---

## Build / test / deploy

```
npx vitest run                                # full suite — keep all tests green
npx vitest run test/eval                      # harness only
npm run build                                 # type-check + transpile
memory eval download                          # one-time dataset fetch
memory eval longmemeval --limit 20            # quick smoke
memory eval longmemeval                       # full benchmark
```

This brief does **not** require a VPS deploy — `memory eval` is a local-only tool.

---

## Acceptance checklist

- [ ] `memory eval download` fetches LongMemEval-S, verifies hash, writes manifest, idempotent on second call
- [ ] `memory eval longmemeval` runs against the downloaded dataset and produces a JSON + markdown report
- [ ] Reports written to `wiki/.audit/longmemeval-{timestamp}.{json,md}` by default
- [ ] `--baseline` flag fails the command if Recall@5 drops below threshold
- [ ] Integration test runs against 10-question fixture without network and passes in under 5 seconds
- [ ] All existing tests still green (currently 616+; you'll add ~10–15 new ones)
- [ ] No new heavy dependencies introduced
- [ ] Dataset cache directory in `.gitignore` (no large files committed)
- [ ] No secrets committed, no OneDrive paths anywhere

If a blocker requires scope creep, **stop and ask** rather than expanding the brief.
