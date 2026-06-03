---
schema_version: 1.4
updated: "{{install_date}}"
applies_from_commit: "{{install_commit}}"
---

# Memory Schema

> This file is the controlling document for the entire memory system. Every wiki page, every observation, every compile/lint/crystallize pass reads this schema and follows its rules. Edit deliberately; commit changes; bump `schema_version` on breaking changes.

---

## 1. Identity

This is **{{user_name}}**'s (`{{user_email}}`, GitHub: `{{github_handle}}`) personal memory system. It is read and written by:

- **Claude Code** (via plugin hooks + MCP)
- **Codex desktop + CLI** (via hooks in `~/.codex/config.toml` + MCP via the same)
- **Antigravity desktop** (via MCP + live-capture plugin hooks when Antigravity 2.x supports them)

Source repo: `C:\CodexProjects\memory-system\`. Runtime data: `~/.memory\` (this directory).

Memory is for **the user's actual work**, not hypothetical content. If a piece of information isn't useful for future-{{user_name}} to retrieve, it doesn't belong here.

---

## 2. Entity types

The wiki is organized by entity category. Every page declares one `type:` in frontmatter and lives in the corresponding directory.

| Category | Directory | Naming | Purpose |
|---|---|---|---|
| `projects` | `wiki/projects/` | `<repo-or-short-name>.md` | A codebase or work effort the user maintains |
| `people` | `wiki/people/` | `<lowercase-first-name>.md` (collisions: `-lastname`) | Someone the user works with, gets feedback from, or builds for |
| `decisions` | `wiki/decisions/` | `<YYYY-MM-DD>-<short-slug>.md` | A choice made with alternatives considered and reasons recorded |
| `lessons` | `wiki/lessons/` | `<short-slug>.md` (no date — lessons are timeless) | A reusable fact learned from a specific incident |
| `issues` | `wiki/issues/` | `<short-slug>.md` | A bug, blocker, incident, failure, or constraint that may have causes and fixes |
| `prospective` | `wiki/prospective/` | `<short-slug>.md` | A future-oriented reminder, trigger, or pending memory to revisit |
| `procedures` | `wiki/procedures/` | `<short-slug>.md` | A reusable workflow with preconditions, ordered steps, verification, and failure cases |
| `threads` | `wiki/threads/` | `<short-slug>.md` | A narrative thread that groups raw observations into a temporal arc |
| `references` | `wiki/references/` | `<short-slug>.md` | External knowledge: papers, blog posts, docs, talks |
| `tools` | `wiki/tools/` | `<package-or-binary-name>.md` | A software dependency or service used by a project |
| `crystal` | `crystals/` | `<YYYY-MM-DD>-<thread-slug>.md` | A long-form distillation of a completed work thread (Wiki v2 addition) |

Raw session files (`raw/<date>/<tool>-<session-id>.md`) carry `type: raw-session` and are not part of the wiki proper — they're the source observations the compile workflow distills into wiki pages.

Wiki dot-directories such as `wiki/.audit/` are operational space, not entity space. They may contain audit logs or runtime metadata, but they are excluded from entity deduplication and graph-health wiki-page metrics. Intentional audit readers may still inspect these files directly. `wiki/compile-proposed/` is also review space for low-confidence autonomous compile operations; its files are not canonical memory until manually reviewed and applied.

Dashboard browse views group curated wiki pages in this order when showing all categories: Decisions, Projects, Issues, Lessons, References, Tools, People, Threads, Procedures, Crystals. Empty groups are omitted. The category grouping is presentation-only and does not change the canonical directory layout above.

---

## 3. Frontmatter contract

Every wiki page (and every raw session file) begins with YAML frontmatter:

```yaml
---
type: projects | people | decisions | lessons | issues | prospective | procedures | threads | references | tools | crystal | raw-session
title: "Human-readable title"
created: 2026-05-21    # ISO 8601 date
updated: 2026-05-21
status: active | archived | superseded   # optional; defaults to active; controls visibility
cognitive_type: core | semantic | episodic | procedural | prospective   # optional; inferred when absent
lifecycle: observed | linked | proposed | consolidated | canonical | stale | disputed | dormant | archived   # optional; memory lifecycle
due: 2026-06-01 | null  # optional; prospective memory deadline
triggers: [event, context, ...]  # optional; prospective memory cues
expires: 2026-07-01 | null  # optional; prospective memory expiry
time_range:  # optional; narrative thread time span
  start: 2026-05-22
  end: 2026-05-27 | null
confidence: 0.0..1.0    # optional legacy scalar; shorthand for confidence.extraction
source: claude-code | codex | antigravity | manual | crystal   # who created this
session: <id>            # optional; the session that produced this page
repo: "C:/absolute/repo/path"       # optional on project pages; authoritative cwd match
repo_paths:                         # optional on project pages; extra authoritative cwd matches
  - "C:/alternate/worktree/root"
relations:
  uses:
    - page-slug
  depends_on:
    - target: page-slug
      confidence: 0.85
      valid_from: 2026-05-21
      valid_to: null
      superseded_by: replacement-page-slug
      source:
        agent: codex
        session_id: session-id
        captured_at: 2026-05-21T12:00:00.000Z
tags: [tag1, tag2, ...]
---
```

**Required:** `type`, `title`, `created`, `updated`. Everything else is optional.

Project pages may set `repo:` or `repo_paths:` to make SessionStart cwd matching authoritative when a checkout directory does not exactly match the page slug. Values are absolute repo or worktree roots. Hooks normalize slashes, casing on Windows, and trailing slashes, then match when the hook `cwd` equals that root or is under it. If these fields are absent, hooks fall back to exact cwd path-segment matching against `wiki/projects/<slug>.md`.

**Required body element:** the first line after frontmatter is a one-sentence summary of the page. This is what shows in `index.md` and search snippets. Lead with the summary; expand below.

Cross-references inside the body use Obsidian-style `[[wiki/projects/agentmemory]]` or shorthand `[[agentmemory]]` when the slug is unambiguous.

### Confidence vector

`confidence` may be either the legacy scalar `0.0..1.0` or a structured vector:

```yaml
confidence:
  extraction: 0.85
  source: 1.0
  validation: user
  freshness: 2026-05-27
  conflict: null
```

- `extraction`: how sure the parser or writer was when extracting the memory.
- `source`: how reliable the originator is for this claim.
- `validation`: `unvalidated`, `auto`, `user`, `challenged`, or `revoked`.
- `freshness`: ISO date or datetime for the last review.
- `conflict`: related page path that conflicts with this claim, or `null`.

Scalar `confidence: 0.85` is backwards-compatible shorthand for `{ extraction: 0.85 }`. If `lifecycle` is missing, readers infer a sensible default: raw observations are `observed`, confident wiki pages are `canonical`, and other wiki pages are `proposed`.

Legacy scalar example:

```yaml
---
type: projects
title: "Memory Fort"
created: 2026-05-21
updated: 2026-05-27
status: active
confidence: 0.85
---
```

Vector example:

```yaml
---
type: decisions
title: "Confidence Vector Lifecycle"
created: 2026-05-27
updated: 2026-05-27
status: active
lifecycle: canonical
confidence:
  extraction: 0.86
  source: 0.95
  validation: user
  freshness: 2026-05-27
  conflict: null
---
```

### Lifecycle stages

- `observed`: raw observation captured but not curated.
- `linked`: raw observation connected to wiki pages by consolidation.
- `proposed`: candidate page or claim awaiting validation.
- `consolidated`: promoted memory that is not yet user-validated.
- `canonical`: user-validated stable memory.
- `stale`: canonical memory past its freshness window.
- `disputed`: memory with unresolved contradicting evidence.
- `dormant`: memory not retrieved for a long time; kept but deboosted.
- `archived`: explicitly retired from active use.

### Cognitive types

- `core`: stable identity, project, or preference memory that should stay highly retrievable.
- `semantic`: factual knowledge, references, decisions, and distilled claims.
- `episodic`: recent raw observations or session-specific events.
- `procedural`: reusable how-to knowledge, tools, and lessons.
- `prospective`: future-oriented memory that should be revisited when a due date, trigger, or context arrives.

Pages under `wiki/prospective/*.md` infer `cognitive_type: prospective` when the field is absent. An explicit `cognitive_type: prospective` is also valid on any non-raw wiki page when a future-oriented memory naturally lives in another category. Use `wiki/issues/` for problems, blockers, incidents, failures, and constraints; use `cognitive_type: prospective` or due/trigger metadata for future orientation.

Pages under `wiki/threads/*.md` infer `cognitive_type: episodic` when the field is absent. An explicit `cognitive_type` override remains valid on non-raw thread pages when a thread is being used as a stable semantic summary.

Pages under `wiki/procedures/*.md` and `wiki/procedures-proposed/*.md` infer `cognitive_type: procedural` when the field is absent. Proposed procedures stay review-only until the operator promotes them.

### Prospective memories

Prospective memories use normal lifecycle stages. New pending items should be `lifecycle: proposed`; once handled, promote or retire them by changing lifecycle and/or status rather than adding new lifecycle states.

```yaml
---
type: prospective
title: "Review Graph Health Calibration"
created: 2026-05-27
updated: 2026-05-27
status: active
lifecycle: proposed
due: 2026-06-03
triggers:
  - weekly verify run
expires: null
source: codex
---
```

The `prospective.overdue` verify check warns at one or two overdue proposed prospective memories and fails at three or more. Archive retired prospective pages or move handled items out of `lifecycle: proposed`.

### Narrative threads

Narrative threads are wiki pages under `wiki/threads/*.md` that turn scattered raw observations into a coherent arc. They are meant to answer "what happened across this stretch of work?" without replacing canonical project, decision, or lesson pages.

Thread pages use `type: threads` and may include a `time_range` object:

```yaml
---
type: threads
title: "Dashboard Health Calibration"
created: 2026-05-27
updated: 2026-05-27
status: active
time_range:
  start: 2026-05-22
  end: null
relations:
  mentions:
    - raw/2026-05-22/codex-dashboard.md
  derived_from:
    - raw/2026-05-23/codex-health-metrics.md
source: codex
---
```

`time_range.start` is required when `time_range` is present and must be a parseable ISO date string. `time_range.end` may be omitted or `null` for an active thread. Malformed `time_range` metadata is dropped with a warning during frontmatter parsing.

Thread pages should use existing `mentions` and `derived_from` relations to cite raw observations. Do not add new edge types for narrative arcs.

The `graph.narrative-thread-coverage` dashboard metric is `n/a` until at least one live thread exists. Once threads exist, it passes when at least 50% of raw observations are referenced by live thread pages, warns below 50%, and fails below 25%.

The dashboard Overview treats graph health as a compact status summary. Metric tiles expand on demand and link to `/memory/health#<metric-id>` for the detailed drill-down, where thresholds and offender records are shown.

Structural graph health metrics operate on reasoning edges only. Provenance and association edge coverage are still reported as informational metrics, but they do not make the reasoning graph look healthier or noisier.

## Auto-thread proposing

`memory thread propose` clusters raw observations and asks the configured LLM
to draft thread pages. Drafts land at `wiki/threads-proposed/<slug>.md` with
`lifecycle: proposed` and `source: auto-thread-propose`. They are NOT counted
toward `graph.narrative-thread-coverage` until the operator validates them.

### Operator workflow

1. `memory thread propose --apply` (default: weekly cadence)
2. `ls ~/.memory/wiki/threads-proposed/` - review drafts
3. Edit any drafts that need adjustment (open in your editor of choice)
4. `memory thread promote <slug>` - moves to `wiki/threads/`, updates
   `lifecycle: consolidated`, `source: auto-thread-propose-validated`
5. OR `memory thread reject <slug>` - deletes the draft

The promoted thread counts toward `narrative-thread-coverage` like any
hand-authored thread.

### Cost

~$0.001 per proposal with `openai/gpt-4o-mini` via OpenRouter.
Default `--max-proposals 10` per run. Free with OpenRouter free-tier
models (`qwen/qwen-2.5-7b-instruct:free`).

### LLM output grounding

Auto-propose pipelines must not invent references. Two layers keep structural
output grounded:

1. The LLM prompt includes an explicit candidate list of existing wiki page
   paths derived from the cluster's observations. The prompt scopes those
   paths to relation context only; free-form fields such as summaries,
   decisions, lessons, steps, and verification must stay human-readable prose.

2. Post-process verification strips any `wiki/<category>/<slug>.md` reference
   whose target file does not resolve. Draft writers run a final filesystem
   check on frontmatter relations before serializing the proposed page.

Procedure proposals also strip unsupported step commands. `memory <subcommand>`
values must name a real Memory Fort subcommand; otherwise the command field is
dropped while the prose step remains.

Prose-field path leaks are stripped separately when a field is just a bare
`wiki/...` or `raw/...` path, while embedded prose mentions are preserved. The
strip rate and `prosePathLeaks` rate are tracked in the LLM audit log per call.
`memory provider audit-summary` surfaces both rates per consumer. It also
reports estimated cost when the provider/model has a known pricing table entry,
keeps Ollama/local calls at explicit `$0.0000`, and marks unknown-priced calls
as `unknown` instead of treating them as free. A persistently high strip rate
(>3 per call sustained) or non-zero prose leak rate signals that the prompt
needs tuning or the model is unsuitable for the task.

`memory provider audit-rotate --plan` lists old `wiki/.audit/` logs that would
be archived; `--apply` moves them into `wiki/.audit/archive/`. The default keeps
30 days of `llm-*.md` and the run-log families `thread-propose-*`,
`procedure-propose-*`, `consolidate-*`, and `compile-*`. Rotation never hard
deletes audit files.

### Auto-promote and inbox

`memory thread propose --apply --auto-promote` and
`memory procedure propose --apply --auto-promote` route high-confidence drafts
directly into `wiki/threads/` or `wiki/procedures/`. Low-confidence drafts stay
under `wiki/threads-proposed/` or `wiki/procedures-proposed/` for review. Without
`--auto-promote`, all drafts keep the existing review-gated behavior.

High confidence requires all of these signals:

- `strippedReferenceCount === 0`
- `prosePathLeaksCount === 0`
- `commandsStripped.length === 0`
- at least 5 observations
- at least 2 distinct sessions

Each proposed draft carries `proposal_confidence` frontmatter with the level,
reasons, observation count, and distinct session count. The dashboard reads this
for `/memory/inbox`, where the operator can promote or reject drafts with the
same backend actions as the CLI commands. The top bar shows an inbox badge when
drafts are awaiting review.

Dashboard startup can schedule propose runs from `config.yaml`:

```yaml
auto_promote:
  enabled: false
  cadence: "weekly" # weekly | daily | manual
  confidence_threshold: high
```

`enabled: false` is the default. `manual` disables scheduling but keeps the
settings visible. `confidence_threshold: none` is accepted in config for manual
operator experiments but is not exposed in the dashboard settings UI; the
recommended and default threshold is `high`.

### Config secrets

Provider secrets are env-var-only. `config.yaml` must never contain API keys,
tokens, passwords, private keys, credentials, or provider secrets of any kind.
Use `VOYAGE_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, or the provider's
documented environment variable instead of adding secret fields to config.

The dashboard defensively redacts any secret-named field returned by
`GET /api/config` at any depth, including fields named `api_key`, `apiKey`,
`secret`, `access_token`, `password`, `credential`, or `private_key`. This is a
leak guard only; it does not make `config.yaml` an approved place to store
secrets.

`config.yaml` is parsed with `js-yaml` using JSON schema, matching the
frontmatter date behavior: unquoted `YYYY-MM-DD` values remain strings rather
than becoming JavaScript `Date` objects. Normal YAML features such as inline
comments, nested maps, block lists, and flow lists are supported.

### Graph retrieval config

Graph spreading activation uses default edge weights that favor reasoning
edges over provenance and association. Operators may override individual
weights in `config.yaml`:

```yaml
graph:
  edge_weights:
    caused_by: 1.2
    linked: 0.05
```

Unspecified weights inherit defaults. Values must be finite non-negative
numbers. Superseded relation entries and relation entries whose `valid_to` has
expired at query time are not traversed by graph expansion or spreading
activation.

### Dashboard reverse proxies

The dashboard same-origin guard honors `X-Forwarded-Proto` and
`X-Forwarded-Host` when they are present. This lets a TLS-terminating reverse
proxy, such as Tailscale Serve in front of the localhost dashboard, reconstruct
the browser-visible origin before accepting mutating API requests.

Unusual proxy deployments can add explicit trusted origins:

```yaml
dashboard:
  trusted_origins:
    - https://srv1317946.tail6916d8.ts.net
```

The list is optional and defaults to empty. Genuine cross-origin requests remain
blocked unless their `Origin` matches the direct dashboard origin, the forwarded
effective origin, or one of the configured trusted origins.

### Agent memory feedback loop

Deliberate MCP observations are committed on write. `memory.log_observation`
appends to the relevant `raw/YYYY-MM-DD/<tool>-<session>.md` file, then makes a
best-effort vault commit for that raw file. Commit failure is logged without
blocking the observation, and the debounced sync path can still propagate the
commit later. New observation blocks include an `observed_at` ISO timestamp in
their metadata line so consumers can sort by write-recency instead of only by
raw file name or coarse heading time.

Session-start injection is bounded and layered:

- `schema.md` reminds agents how the vault is structured.
- `index.md` is emitted through the confidence-aware filter.
- `log.md` is tailed to the last 20 lines.
- `wiki/preferences.md` is always surfaced when present, even if it is absent
  from `index.md`.
- The "What you should remember" block surfaces preference-tagged pages and
  preference-tagged observations with independent caps, plus the most recent
  high-confidence raw observations. Counts and excerpts are capped so raw
  capture does not flood the prompt.

Use `wiki/preferences.md` for durable behavior-shaping directives. Keep entries
short, actionable, tagged `preference` when they live elsewhere, and grounded in
operator instructions. Raw observations become visible immediately through the
recent-observations block and exact-token lexical search; compile can later
curate durable facts into wiki pages.

MCP `memory.search` defaults to `no_rerank=true` for latency-sensitive recall,
which keeps typical calls within the MCP client timeout by using BM25, vectors,
graph, exact, and metadata fusion without the slower Voyage rerank step. Callers
can pass `no_rerank=false` when they need the higher-latency rerank path. BM25
indexes every raw/wiki/crystal markdown file it can read, including files that
do not yet have embeddings; vector scoring skips only the missing embedding
rows until the normal embedding refresh catches up.

### Diagnostic env vars

`MEMORY_LLM_DEBUG_LOG=1` enables plaintext LLM prompt/response logging for
local diagnostics. The switch is strict: only the exact string `1` enables it.
When enabled, each audited LLM call also appends the full prompt and response
to `wiki/.audit/llm-debug-YYYY-MM-DD.md`.

These files are sensitive and are ignored by runtime vault git by default.
Disable the mode with `unset MEMORY_LLM_DEBUG_LOG` on POSIX shells or
`Remove-Item Env:MEMORY_LLM_DEBUG_LOG` in PowerShell.

---

## Procedural memory (cognitive type)

Procedural memories live at `wiki/procedures/<slug>.md` with `cognitive_type: procedural`. A procedure is a reusable workflow - preconditions, ordered steps, verification, and failure cases - that the operator runs more than once.

### Schema additions

| Section | Type | Required | Meaning |
|---|---|---|---|
| Preconditions | bulleted list | yes | Required state before running |
| Steps | numbered list, optional fenced commands | yes | Ordered actions |
| Verification | bulleted list | yes | How to confirm success |
| Failure cases | definition list (condition -> remedy) | optional | Recovery paths for known failure modes |

All other Brief A/B fields apply normally.

### Auto-extract proposing

`memory procedure propose` detects clusters of raw observations sharing command-line signatures across multiple sessions and asks the configured LLM to draft procedure pages. Drafts land at `wiki/procedures-proposed/<slug>.md` with `lifecycle: proposed` and `source: auto-procedural-extract`. The operator validates and promotes via `memory procedure promote <slug>` or the dashboard inbox at `/memory/inbox`.

Same propose -> review -> promote workflow as auto-thread-proposing. Cost ~$0.001 per proposal on `openai/gpt-4o-mini`, default `--max-proposals 10`. Free with `qwen/qwen-2.5-7b-instruct:free`.

Detection requires at least 3 observations from at least 2 distinct sessions with a successful outcome. One-off solutions are lessons, not procedures.

---

## Retrieval intent classification

Dashboard search runs queries through an intent classifier before retrieval. Seven intent buckets:

| Intent | Meaning | Example query |
|---|---|---|
| decision | What was decided / why X over Y | "what did we decide about embeddings" |
| procedure | How to do something | "how do I deploy the dashboard" |
| episodic | What happened / when | "when did we add prospective memory" |
| preference | User/operator preferences | "what does the user prefer about Voyage" |
| current-truth | Current state of something | "what is the current vault size" |
| code-context | Code, implementations, files | "where is the consolidation runner" |
| open-ended | Catch-all | anything not matching above |

Heuristic-first classification handles obvious queries with no LLM call. Remaining queries fall through to the configured LLM, when available, at about $0.0001 per call on `openai/gpt-4o-mini`. Each intent maps to per-stream weight multipliers applied before RRF fusion. The `open-ended` weights are uniform (1.0 across all streams), reproducing baseline behavior.

Operators can override with `?intent=<bucket>` on the `/api/search` URL query, or inspect one query via `memory provider test-classifier "<query>"`. The classifier honors `MEMORY_LLM_DISABLED=true`; when disabled, every query takes the `open-ended` path.

---

## 4. Naming rules

- All filenames are **lowercase kebab-case**: `lisan-studio.md`, not `LisanStudio.md` or `lisan_studio.md`.
- Compile operation paths normalize only the filename slug segment. `wiki/projects/iAqar.md` becomes `wiki/projects/iaqar.md`; directories such as `wiki/projects/` and operational targets such as `index.md` and `log.md` are not slug-normalized.
- Date prefixes use **ISO 8601** (`YYYY-MM-DD`), zero-padded.
- Slugs are short and grep-friendly — favor `windows-stale-ports` over `the-time-windows-held-stale-listening-sockets-on-3111`.
- For decision pages, the date is the date the *decision was made*, not the date the page was written.
- For lesson pages, no date prefix — lessons are timeless.
- Person pages: first name only unless there's a collision; use `-lastname` only to disambiguate.

---

## 5. Edge types (knowledge graph)

The graph is derived on-demand from `relations:` frontmatter (and inline `[[wikilinks]]` which create implicit `linked` edges). Eleven canonical edge types are supported — the exact set `validateFrontmatter` accepts; any other key is rejected. Use them precisely.

| Type | Direction | Semantics | Example |
|---|---|---|---|
| `mentions` | A → B | A references B; the generic auto-write key for raw observations | `raw/2026-05-20/*` mentions `wiki/projects/agentmemory.md` |
| `uses` | A → B | A is a project that uses B (a tool/library) | `agentmemory` uses `typescript` |
| `depends_on` | A → B | A's functioning requires B | `lisan-studio` depends_on `qt6` |
| `supersedes` | A → B | A replaces B; B is archived | `lisan-studio` supersedes `vs-code-arabic` |
| `contradicts` | A → B | A's content disagrees with B; needs human resolution | `2026-05-21-restore-onedrive-data` contradicts an earlier decision page |
| `caused_by` | A → B | A (a problem or event) was caused by B | `stale-listening-sockets` caused_by `iii-config-port-hardcoding` |
| `fixed_by` | A → B | An issue was fixed by B (a decision, procedure, or tool) | `dead-pid-survivor-guard` fixed_by `2026-05-20-decide-stop-action-filter` |
| `learned_from` | A → B | A lesson was learned from B (an issue, decision, or procedure) | `windows-safe-vars` learned_from `powershell-parser-failure` |
| `derived_from` | A → B | A's content was distilled from B (typical: crystal from raw thread) | `2026-05-20-agentmemory-stabilization` derived_from `raw/2026-05-20/*` |
| `mentioned_in` | A → B | A appears in B (often auto-extracted by implicit graph) | `voyage-3.5` mentioned_in `2026-05-20-embedding-provider-choice` |
| `linked` | A → B | Generic association; least specific. Inline `[[wikilinks]]` create implicit linked edges. | Use only when no more-specific type applies |

When in doubt, pick the more specific edge. `linked` is the fallback. `mentions` is also accepted as a backwards-compatible auto-write key for raw observations and is treated as a generic mention edge.

Reasoning edges are `uses`, `depends_on`, `caused_by`, `fixed_by`,
`contradicts`, `supersedes`, and `learned_from`. Provenance edges are
`derived_from`, `mentioned_in`, and `mentions`. Association edges are `linked`
and implicit `wikilink` edges. Retrieval weights and graph-health structure
use these classes so provenance and loose links do not masquerade as causal or
dependency signal.

### Advisory edge grammar

`memory lint --checks-only` reports edge-grammar issues as advisory findings.
They are included in the lint report and counts, but they do not make
`hasBlockingIssues` true.

| Relation | Expected source | Expected target |
|---|---|---|
| `caused_by` | `issues` | `issues`, `decisions`, `tools`, or `references` |
| `fixed_by` | `issues` | `decisions`, `procedures`, or `tools` |
| `learned_from` | `lessons` | `issues`, `decisions`, or `procedures` |

`fixed_by` edges from or to `lessons` are suspect because lessons describe
fixes; they do not fix issues themselves. Prefer `learned_from` when a lesson
records what an incident taught.

### Relation entry shapes

Each `relations.<type>` value is an array. Entries can use either string shorthand or object form:

```yaml
relations:
  mentions:
    - wiki/projects/memory-system.md
    - wiki/tools/voyage.md
  uses:
    - wiki/tools/typescript.md
  linked:
    - wiki/references/dashboard-notes.md
```

```yaml
relations:
  mentions:
    - wiki/projects/memory-system.md
    - target: wiki/tools/voyage.md
      confidence: 0.85
      valid_from: 2026-05-22
      source:
        agent: codex
        session_id: codex-abc123
        captured_at: 2026-05-22T14:15:00.000Z
  supersedes:
    - target: wiki/decisions/old-dashboard-port.md
      valid_from: 2026-05-23
      valid_to: null
      superseded_by: wiki/decisions/new-dashboard-port.md
```

String shorthand is exactly equivalent to object form with only `target` set:

```yaml
- wiki/tools/voyage.md
```

is equivalent to:

```yaml
- target: wiki/tools/voyage.md
```

The consolidation pipeline auto-writes string shorthand under the classified
`relations.<type>` key. Humans and future tools may write rich object entries
when relation metadata matters.

Validation, lint, graph checks, and compile-execute grounding all read relation
targets through the same relation parser. Object-form entries are preserved
when their `target` resolves, and removed only when the target is ungrounded or
the entry is malformed.

### Consolidation edge-type classification

The `memory consolidate` pipeline assigns each proposed match an edge type
based on these rules, evaluated in order with the first match winning:

1. Target in `wiki/tools/*.md` -> `uses`
2. Target in `wiki/crystals/*.md` -> `derived_from`
3. Title contains `deprecated` or `superseded-by` -> `supersedes`
4. BM25-only match against a decision or lesson -> `derived_from`
5. Catch-all -> `mentions`

Lexical matches, where the raw observation body literally contains the wiki
page title, stay as `mentions` unless overridden by rules 1-3. A literal
mention is treated as a stronger semantic signal than topical overlap.

### Temporal fields

- `valid_from`: ISO date or datetime when the edge became valid. If omitted, readers may default to the source document's `created` date.
- `valid_to`: ISO date or datetime when the edge stopped being current. `null` or omission means the edge is currently valid.
- `superseded_by`: target page path for the edge that replaced this one.

### Source fields

Object-form edges may include `source` metadata:

- `source.agent`: tool or agent that captured the edge (`codex`, `claude-code`, `antigravity`, `manual`, etc.).
- `source.session_id`: session that produced the relation.
- `source.captured_at`: ISO datetime when the relation was captured.

### Entity alias map

Entity deduplication records reviewed aliases in `wiki/.entity-aliases.json`.
The file maps each alias string or legacy relation target to the canonical
entity target. For example:

```json
{
  "version": 1,
  "updatedAt": "2026-05-28T00:00:00.000Z",
  "aliases": {
    "LisanStudio": "wiki/projects/lisan-studio.md",
    "wiki/projects/lisanstudio.md": "wiki/projects/lisan-studio.md"
  }
}
```

Duplicate detection normalizes candidate entity names by lowercasing and
stripping non-alphanumeric separators, so `Lisan Studio`, `lisan-studio`, and
`LisanStudio` share the normalized form `lisanstudio`. It also surfaces
near-matches with high string similarity for review. Detection is automatic,
but merges are never automatic: run `memory entity dedup --plan`, review the
proposals, write them with `memory entity dedup --apply`, then approve one
canonical target at a time with `memory entity merge <canonical>`. Rejected
proposals are removed with `memory entity reject <canonical>`.

Merging rewrites relation targets from aliases to the canonical target and
records the alias map. It never deletes raw observations or wiki pages.

---

## 6. Quality standards

- **One-sentence summary line** is mandatory (first line of body, after frontmatter).
- **Cite the session** for claims dependent on a specific work session: `[per session claude-code-abc123]`.
- **Contradictions are recorded, not deleted.** If new information disagrees with an existing page, add a `contradicts: [old-page]` entry in the new page's frontmatter AND a `contradicts: [new-page]` in the old page's frontmatter. The lint pass surfaces these for resolution.
- **Low-confidence pages get `confidence: <value>` < 0.5.** Lint surfaces them as DRAFT — they're real but tentative.
- **Wait for cross-session signal before creating a wiki page from a single session's observations.** Single-session content lives in raw/ until the compile pass sees the same theme across multiple sessions OR until the user explicitly promotes it.
- **No marketing language, no AI clichés.** Plain factual statements. "Voyage 3.5 retrieval is ~8% better than text-embedding-3-large on the user's domain mix" — not "Voyage 3.5 is the best-in-class state-of-the-art solution."

---

## 7. Privacy filtering

The ingest workflow strips sensitive content before writing to wiki/:

- **API key patterns:** `sk-[a-zA-Z0-9_-]{20,}`, `AIza[a-zA-Z0-9_-]{30,}`, `gh[ps]_[a-zA-Z0-9]{36,}`, `Bearer [a-zA-Z0-9_.-]+`
- **Specific env values:** `AGENTMEMORY_SECRET`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `VOYAGE_API_KEY`, anything from `~/.env` or `~/.agentmemory/.env`
- **Credentials in URLs:** `https?://[^:]+:[^@]+@` (user:password@host)
- **Private SSH keys / certs:** content starting with `-----BEGIN ` (any PEM block)
- **Anything in the source explicitly tagged** `<!-- private -->` or `<!-- redact -->`

Filtered text is replaced with `[REDACTED: <category>]`. The original raw content stays in `raw/` (which is gitignored by default per `config.yaml`) so the user can audit; only the wiki/ and crystals/ get filtered.

If a regex flags something that *should* be in the wiki (e.g., a public commit hash that happens to match a key pattern), add an allowlist entry to `config.yaml: privacy.allowlist`.

---

## 8. Ingest workflow

When `memory compile` runs (manually or via scheduled task), the compile prompt
is assembled from raw observations and the LLM/operator performs:

1. **Read raw observations** since the last compile (per `log.md`'s last `## [date] compile` entry).
2. **Extract entities and themes.** For each candidate entity, check if a wiki page already exists.
3. **Update existing pages** only when the current page body lacks genuinely new facts from the raw observations; add new content under a `## [YYYY-MM-DD] update` heading and preserve all prior content.
4. **Create new pages** only when the cross-session signal threshold is met (see §6).
5. **Let the executor rebuild `index.md`** deterministically from canonical wiki pages after successful execute runs.
6. **Append to `log.md`** a single line: `## [YYYY-MM-DD HH:MM] compile | N raw sessions → M wiki updates, K new pages`.
7. **Apply privacy filter** on every page mutation (§7).
8. **Propose graph edges** (implicit graph extraction, Phase 3+): for each entity pair the LLM identifies, suggest an edge type with confidence; write proposals to `relations-proposals.md` for human review.

Dashboard scheduling is controlled by:

```yaml
compile:
  scheduled: false
  cadence: daily # daily | weekly | manual
  execute: false
```

`scheduled: false` and `cadence: daily` are the defaults. When explicitly
enabled, the dashboard scheduler invokes the same `runScheduledCompileOnce`
path as the CLI, writes the scheduled prompt artifact under `state/`, updates
`state/compile-state.json`, and appends a compile line to `log.md`. Scheduler
defaults remain prompt-artifact only; scheduled LLM execution happens only when
`compile.execute: true`.

The `/memory/compile` page shows the configured cadence. Its primary **Run
compile now** action confirms with the operator, then posts
`POST /api/compile/run` with `{ execute: true }` so high-confidence operations
apply directly and low-confidence operations stage in `wiki/compile-proposed/`.
Its secondary **Generate prompt only** action posts `{ execute: false }` and
returns the scheduled prompt artifact path. Scheduled compile work is serialized
with auto-promote proposal runs so vault-writing operations do not overlap.

Autonomous compile execution accepts `write_page`, `rewrite_page`,
`append_page`, and `append_log` operation kinds. Legacy `update_index`
operations are accepted as no-ops for compatibility; the model should not emit
them. `write_page` creates a new canonical wiki page. `rewrite_page` replaces an
existing page body with a complete curated article that preserves substantive
facts while removing redundancy. `append_page` preserves an existing page and
appends a dated section only for genuinely time-stamped events. For wiki page targets under `wiki/<category>/<slug>.md`, the executor
normalizes the slug, infers `type` from the category only for known categories
(`projects`, `people`, `decisions`, `lessons`, `issues`, `references`, `tools`,
`threads`, `procedures`, `prospective`), rejects unknown category directories, converts a
missing-page `append_page` into a staged create proposal, and merges multiple
operations for the same normalized page before writing. Every rewrite archives
the previous page under `wiki/.history/<path>/<timestamp>.md`; rewrites that
shrink below the content-preservation threshold stage in `wiki/compile-proposed/`
for review instead of applying directly. `append_log` keeps its fixed `log.md`
path and is not a page create operation. `memory reindex` and non-plan compile
execute runs regenerate `index.md` from the canonical `wiki/` tree, grouped by
page type and excluding `.audit/`, `*-proposed/`, and `archive/`.

---

## 9. Lint rules

`memory lint` checks the wiki for hygiene issues and emits `lint-report.md`:

| Check | What it flags |
|---|---|
| Frontmatter validity | Missing required fields; unknown `type:`; malformed dates; unknown `status:` |
| Orphan pages | Pages with no inbound `[[wikilinks]]` AND no inbound `relations:` references |
| Broken links | `[[wikilinks]]` whose target page does not exist |
| Stale pages | `status: active` AND `updated` > 180 days ago |
| Overdue prospective memories | `cognitive_type: prospective`, `lifecycle: proposed`, and `due` before the verify run date |
| Narrative thread coverage | Raw observations not referenced by any live `wiki/threads/*.md` page once threads exist |
| Contradictions | Pages whose `relations.contradicts` resolves to another page, unresolved |
| Edge grammar | Advisory checks for suspicious `caused_by`, `fixed_by`, and `learned_from` source/target types |
| Low-confidence drafts | `confidence: < 0.5` AND `status: active` |
| Naming violations | Filenames not matching lowercase-kebab-case or the type's prefix pattern |
| Privacy regressions | Any page whose content matches a §7 redaction pattern post-filter |

The user reads `lint-report.md`, decides what to fix, edits the pages. Lint does NOT auto-fix.

---

## 10. Anti-patterns

Do NOT:

- **Create a `people/X.md` page for a one-off mention.** Wait for 3+ references across sessions before creating.
- **Silently delete contradictions.** Always record both sides via `relations.contradicts` and let lint surface them.
- **Write a wiki page from a single session's content.** Wait for cross-session signal (§6) or explicit user promotion.
- **Use marketing language** ("best-in-class", "state-of-the-art", "robust") in wiki pages. State facts.
- **Embed long verbatim quotes** from external sources — link to the reference page instead.
- **Include emojis** unless the user explicitly used them.
- **Bypass privacy filter** to keep a "useful" credential in the wiki. There's no useful credential; rotate it.
- **Update `confidence:` to 1.0** without evidence. New claims start at 0.5-0.7; only promote to 1.0 after the claim survives multiple uses or explicit verification.
- **Add new edge types** beyond the eleven in §5. If a new relationship type seems needed, propose it via `lint-report.md` for schema version bump.

---

## 11. Operational storage behavior

Writes that replace existing files use the repo's atomic write primitive: write a sibling `.tmp` file, fsync it, close it, then rename it over the canonical path. On Windows, the final rename may briefly fail when another local process is reading the target file. The writer retries only transient Windows rename errors (`EPERM`, `EACCES`, `EBUSY`, `ENOENT`) with 50 ms, 150 ms, and 400 ms backoff before surfacing the original error.

The `storage.atomic-write-retries` verify check reports process-local retry counters. A retry rate below 1% passes, 1% to under 10% warns, and 10% or higher fails because it usually points to a stuck file handle, Defender interference, OneDrive sync, or another host-level file-system issue.

---

## 12. User identity & preferences

(Ported from agentmemory's slice-7 `personalize galaxyruler` plan, distilled here so the LLM doing curation knows who it's curating for.)

**Persona:** {{user_name}} is a software researcher/analyst at a research center. Reverse engineering focus. Deep technical analysis preferred over surface coverage. Personal-use repos and infrastructure dominate the work.

**Working style:**
- Momentum-driven; terse confirmations are common ("ok", "yes", "go")
- Picks options decisively; doesn't enjoy excessive clarifying-question rounds
- Demands online grounding for any factual claim — verify before stating
- Reads in Claude Desktop; markdown file paths should be `code "<abs-path>"` blocks for one-click copy, not vscode:// links
- Uses Claude Code (CLI), Codex desktop (primary implementer), Antigravity desktop, plus rarely Codex CLI

**Tools and contexts:**
- Primary OS: Windows 11
- Source repos: `C:\CodexProjects\<project>\` and `C:\Users\Admin\<project>\` (never OneDrive)
- GitHub identity: `{{github_handle}}` / `{{user_email}}` (NOT the gmail)
- Codex routing: handoff format is raw prompt body (no echo headers), pasted into Codex Desktop sessions

**Active projects to recognize:**
- agentmemory (GalaxyRuler/agentmemory; this system's predecessor)
- Lisan Studio (Native Qt 6 Arabic-first IDE)
- Arabic Python (apython dialect)
- VeriTrace (KiCad design-agent web UI)
- iAqar (Riyadh investment analyzer)
- Personal Website (GalaxyRuler/mysiteagain)
- Homelab (isolated lab runners)

**Documentation conventions:**
- File paths in chat: `code "<abs-path>"` fenced block for one-click copy
- Commit author: `{{user_name}} <{{user_email}}>`
- Conventional Commits prefixes (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `build:`, `refactor:`)
- Never edit OneDrive paths

---

## 13. Versioning

This file's frontmatter declares `schema_version`. When the schema changes in a way that affects existing wiki pages (new required fields, removed entity types, renamed edge types), increment the version:

- **Patch increment** (e.g., 1 → 1.0.1): docs/wording tweaks; existing pages still valid.
- **Minor increment** (1.0 → 1.1): new optional fields, new edge types; old pages remain valid without migration.
- **Major increment** (1 → 2): breaking change; old pages need migration. The compile workflow on first run after a major bump runs a migration pass and writes `migration-log.md`.

Schema changes are reviewed via `git diff` — the user sees the change, decides if it warrants a version bump, commits both the schema change and the version increment in one commit.

---

*This template is copied by `memory init` into `~/.memory/schema.md` with template variables (`{{user_name}}`, `{{user_email}}`, `{{install_date}}`, `{{github_handle}}`, `{{install_commit}}`) substituted at copy time. After install, this file is the user's to edit — `memory init --reset` preserves a backup before overwriting.*
