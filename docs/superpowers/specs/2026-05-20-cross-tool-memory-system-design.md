# Cross-Tool Memory System — Design

**Date:** 2026-05-20
**Author:** Abdullah (`aoa@live.ca`, GitHub: GalaxyRuler)
**Status:** Draft — pending user review
**Replaces:** the user's daily reliance on GalaxyRuler/agentmemory (the agentmemory project itself remains in place for any external users; this is a personal-use migration)

---

## 1. Mission

A single, file-system-backed memory system that:

1. Captures observations from three coding agents — **Claude Code**, **Codex CLI**, and **Google Antigravity** — using each platform's native hooks plus a shared MCP server.
2. Curates raw observations into a structured **markdown wiki** following Andrej Karpathy's LLM Wiki pattern (April 2026) and the "LLM Wiki v2" extensions (April 2026, agentmemory lessons).
3. Has **zero persistent daemons, zero ports, zero databases, zero migrations**. Storage is plain markdown + small JSON sidecars under one directory; git is the durable backup; recovery from any disaster is `git checkout`.
4. Is **simplest possible while remaining feature-rich, reliable, and state-of-the-art** — the four-criterion brief the user posed in brainstorming.

It explicitly is NOT a daemon-based system. It does not run continuously. It does not bind ports. It does not have a SQLite store. Every reliability failure documented in the `codex/windows-codex-desktop-stability` session is structurally absent from this design because the components that fail in agentmemory do not exist here.

---

## 2. Core principles

1. **Files are the source of truth.** Anything not on disk under `~/.memory/` does not exist.
2. **Markdown is the storage format.** Human-readable, ripgrep-able, git-versionable, Obsidian-compatible, future-proof beyond any specific tool.
3. **The LLM is the engine, not a separate process.** Curation, lint, crystallize, query — all performed by whichever LLM is in front of the user (Claude / Codex / Antigravity), invoked via slash commands or scheduled hooks. No separate "memory engine" process.
4. **Hooks ingest passively. MCP queries actively.** Two complementary paths, one storage backend.
5. **Embeddings are sidecars, not a database.** Vectors live in `*.embeddings.jsonl` files next to the markdown they index. No vector DB to run.
6. **Git is the backup, history, and rollback layer.** No custom snapshot/restore code. `git log`, `git diff`, `git checkout`, `git restore`.
7. **No platform is a special case.** Each platform sees the same memory directory; each gets a thin manifest that points the platform's hook system at the shared script.
8. **Errors are loud.** Hook failures write to a `errors.log` file the user can grep. No silent `} catch {}` swallowing.

---

## 3. Storage layout

```
~/.memory/                                    ← single root; everything here
  README.md                                   ← human entry point: what this is, how to use
  schema.md                                   ← controlling document (entity types, rules)
  index.md                                    ← catalog of curated wiki pages (Karpathy)
  log.md                                      ← append-only timeline (Karpathy)
  errors.log                                  ← hook errors; loud failure surface
  config.yaml                                 ← embedding provider, retention windows, paths
  raw/
    2026-05-20/
      claude-code-<session-id>.md             ← session observations, one file per session
      codex-<session-id>.md
      antigravity-<session-id>.md
  wiki/
    projects/
      agentmemory.md                          ← page per entity
      lisan-studio.md
      apython.md
    people/
      abdullah.md
    decisions/
      2026-05-20-relocate-agentmemory.md
    lessons/
      windows-stale-ports.md
      iii-config-port-hardcoding.md
    references/
      karpathy-llm-wiki-pattern.md
  crystals/
    2026-05-20-agentmemory-stabilization-session.md   ← distilled long-form digests
  embeddings/
    wiki.embeddings.jsonl                     ← {path, hash, vector, model, ts} per wiki page
    raw.embeddings.jsonl                      ← rolling N-day window
    embeddings.meta.json                      ← provider, dim, model version
  scripts/
    (the hook and curation scripts live here, symlinked from each platform's plugin dir)
  .git/                                       ← versioning; commits are the audit trail
  .gitignore                                  ← excludes errors.log, transient artifacts
```

**Path conventions:**
- Wiki page filenames are lowercase-kebab-case
- Date prefixes use ISO 8601 (`YYYY-MM-DD`)
- Cross-references use `[[wiki/projects/agentmemory]]` (Obsidian-compatible)
- Session files are named `<tool>-<session-id>.md` where `<tool>` ∈ `{claude-code, codex, antigravity}`

**Why this layout:**
- A user can `cd ~/.memory && rg "stale ports"` and find everything in seconds — no daemon, no API, just text.
- Obsidian opens the directory natively and gives a free GUI with graph view if desired.
- Git's diff/blame/log give time-travel, attribution, and undo for free.
- The split `raw/` vs `wiki/` mirrors Karpathy's "source code vs compiled binary" mental model.

### 3.1 Storage growth and retention

The four storage components grow at very different rates and need different treatment:

| Component | Growth rate | Bounded? | Strategy |
|---|---|---|---|
| `raw/` | Linear with session activity. ~400 KB/session × 5-10 sessions/day = 2-4 MB/day | **No** | **Retention window with compile-before-delete** |
| `wiki/` | Bounded by entities the user actually has. ~5 KB/page × ~1000 pages = 5 MB | Yes | Slow growth; manual review only |
| `crystals/` | Bounded by intentional creation. ~20 KB × ~100/year = 2 MB/year | Yes | Never auto-delete; user-curated |
| `embeddings/` | 4 KB/page (1024-dim float32) or 2 KB/page (512-dim Matryoshka). Bounded by source page count. | Yes | Auto-prunes when source files removed |

**Without retention, raw/ accumulates ~1.5 GB/year under heavy use.** After git compression that's ~450 MB/year in `.git/objects/`. Manageable but not free, and grows unbounded.

**Retention policy** (default; all values configurable in `config.yaml`):

```yaml
retention:
  raw_window_days: 90              # raw/<date>/ files older than this are eligible for archival
  raw_compile_before_delete: true   # always run compile to extract wiki-worthy content first
  embeddings_prune_with_raw: true   # drop raw/* embeddings when source files archived
  wiki_status_stale_days: 180       # active wiki pages updated > N days ago get "stale" lint flag
  crystals_never_auto_delete: true  # crystals are intentional; preserve forever
  archive_before_delete: true       # move to ~/.memory/.archive/ (gitignored) before deletion
```

**Operational loop:**

1. `memory compile` runs first and extracts anything wiki-worthy from expiring raw/ files.
2. `memory retain --apply` (or a scheduled task once a week): moves expired raw/ files to `.archive/`, prunes corresponding embedding records.
3. `.archive/` is gitignored. User can `rm -rf .archive/` for hard cleanup once confident.
4. Per-file override: `keep: true` in raw frontmatter prevents auto-archival.

**Storage budget projections** with default 90-day retention:

| Use level | Steady-state on-disk | After 5 years |
|---|---|---|
| Light (1-2 sessions/day) | ~200 MB | ~250 MB (wiki + crystals + git history grow) |
| Moderate (5-10 sessions/day) | ~1.5 GB | ~2 GB |
| Heavy (20+ sessions/day) | ~3 GB | ~5 GB |

Compare to agentmemory's data store (33 files, ~1 MB at last snapshot) — same order of magnitude per active window; the difference is human-readable markdown rather than opaque binary blobs, so the storage is auditable, grep-able, and git-compressible.

---

## 4. Schema (`schema.md`) — the controlling document

`schema.md` is the most important file in the system. It tells whichever LLM is doing curation: what to extract, how to name, when to merge, when to split, what's out of scope. Following the Wiki v2 advice: this is what humans curate and what the LLM reads on every operation.

### 4.1 Entity types

The wiki tracks these page categories. Each has a directory and a frontmatter `type:`.

| Category | Frontmatter `type:` | Purpose |
|---|---|---|
| Project | `project` | A codebase the user works on |
| Person | `person` | Someone the user interacts with (collaborator, user, etc.) |
| Decision | `decision` | A choice with reasons + alternatives considered |
| Lesson | `lesson` | A reusable fact learned from a specific incident |
| Reference | `reference` | External knowledge (papers, docs, blog posts) |
| Tool | `tool` | A specific software dependency or service used |
| Session-crystal | `crystal` | A long-form distillation of a completed work thread |

### 4.2 Frontmatter contract

Every wiki page starts with YAML frontmatter:

```yaml
---
type: project | person | decision | lesson | reference | tool | crystal
title: "Human-readable title"
created: 2026-05-20
updated: 2026-05-20
status: active | archived | superseded
confidence: 0.0..1.0     # how sure are we about the content
source: claude-code | codex | antigravity | manual | crystal
session: <id>            # optional; the session that produced this page
relations:
  uses: [tool-name, ...]
  depends_on: [project-name, ...]
  supersedes: [page-path, ...]
  contradicts: [page-path, ...]
  caused_by: [page-path, ...]
  fixed_by: [page-path, ...]
  linked: [page-path, ...]
tags: [windows, stability, ...]
---
```

Required fields: `type`, `title`, `created`, `updated`, `status`. Everything else is optional. The frontmatter IS the knowledge graph — typed edges between pages via `relations`.

### 4.3 Naming rules

- Project pages: `wiki/projects/<repo-or-short-name>.md`
- Person pages: `wiki/people/<lowercase-first-name>.md` (collisions disambiguated with `-lastname`)
- Decision pages: `wiki/decisions/<YYYY-MM-DD>-<short-slug>.md`
- Lesson pages: `wiki/lessons/<short-slug>.md` (no date — lessons are timeless)
- Reference pages: `wiki/references/<short-slug>.md`
- Tool pages: `wiki/tools/<package-or-binary-name>.md`
- Crystal pages: `crystals/<YYYY-MM-DD>-<thread-slug>.md`

### 4.4 Quality standards

- Every wiki page has a one-sentence summary as the first line after frontmatter, before any heading.
- Claims that depend on a specific session or source cite the session: `[per session claude-code-abc]`.
- Contradictions are NOT deleted — they're recorded under `relations.contradicts` and flagged for resolution in `log.md`.
- Pages with `confidence < 0.5` get a "DRAFT" tag and surface in lint output.

### 4.5 Privacy filtering

On ingest, the LLM strips:
- API keys (regex `sk-[a-zA-Z0-9]+`, `AIza[a-zA-Z0-9_-]+`, bearer tokens)
- File paths under `~/.ssh/` or anything matching credential patterns
- Email passwords, anything in `.env` files
- The `AGENTMEMORY_SECRET` env var value
- Anything explicitly tagged with `<!-- private -->` in the source

Filtered text is replaced with `[REDACTED: <reason>]`. Original raw text stays in `raw/` (gitignored by default; user can opt in to commit raw).

### 4.6 Obsidian as the GUI — first-class, not optional

`~/.memory/` IS an Obsidian vault by design. Obsidian is the **primary visualization and editing surface** for the wiki. The user opens Obsidian → File → Open Vault → `~/.memory/` → has the entire memory system as a navigable, graph-visualized, full-text-searchable knowledge base.

**What Obsidian gives for free** (no implementation cost on our side):

| Feature | What it does |
|---|---|
| **Graph View** | Interactive visualization of all `[[wikilinks]]` and frontmatter relations. **This IS the graph-memory visualization.** Zoom, filter by tag/folder, color by type. |
| Backlinks panel | Every page shows what links to it — derived live from the link graph |
| Tag explorer | Browse and filter by `#tag` (inline) or `tags: [...]` (frontmatter) |
| Full-text search | Across all markdown; supports regex, tag, file-property filters |
| Outline panel | Per-page table of contents |
| Hover preview | Hover over a `[[wikilink]]` shows the target's content |
| Dataview plugin | SQL-like queries over frontmatter (e.g., `LIST FROM #lesson WHERE updated > date(today)-90`) |
| Daily Notes plugin | Optional auto-daily-journal pages that cross-link into wiki |
| Templates plugin | New-page templates aligned with our schema |
| Canvas files | Visual maps of clusters of pages connected by edges |

**Compatibility commitments our system MUST hold:**

- Frontmatter is YAML (Obsidian's parser is YAML-only; no TOML).
- `[[wikilinks]]` use filename-only form when slugs are unique (`[[agentmemory]]`) or relative-path form (`[[projects/agentmemory]]`) when not.
- Tags in frontmatter use list form `tags: [windows, stability]` — Obsidian renders these in Tags panel.
- Filename casing is consistent for cross-platform portability (we're Windows-primary; Obsidian is case-insensitive but be consistent).
- Markdown sticks to CommonMark + Obsidian-flavored extensions; no syntax Obsidian doesn't render (no RST-style admonitions, no custom directives).
- ISO 8601 dates (`2026-05-20`) — matches Obsidian's Daily Notes default.

**User workflow with Obsidian active:**

1. Chat with Claude/Codex/Antigravity — observations flow via hooks into `raw/`.
2. Periodically run `memory compile` (or let session-end hook do it) — raw becomes curated wiki pages.
3. Open Obsidian to explore: Graph View for visual structure, Backlinks for context, full-text search for retrieval.
4. Edit pages directly in Obsidian if the LLM-curated version needs human refinement — it's just markdown.
5. Use Dataview plugin for custom queries the MCP server doesn't expose.

**Obsidian is NOT required.** Everything works via grep + the LLM in your agent without Obsidian installed. But the user's "utilize Obsidian" requirement is satisfied: every Obsidian feature works against our vault layout from day one.

---

## 5. Ingestion — passive (hooks)

### 5.1 Shared hook scripts

Under `~/.memory/scripts/`:

| Script | Triggered by | What it writes |
|---|---|---|
| `session-start.mjs` | each platform's SessionStart event | Reads `schema.md` + `index.md` + recent `log.md` + any pages matching the project; injects into agent context. NO file writes. |
| `prompt-submit.mjs` | UserPromptSubmit (each platform) | Appends prompt text to `raw/<date>/<tool>-<session>.md` under a `## Prompt` heading |
| `post-tool-use.mjs` | PostToolUse (each platform) | Appends tool name + truncated input + truncated output to the same raw file under `## ToolUse` heading |
| `pre-compact.mjs` | PreCompact (each platform) | Appends a compaction marker to the raw file; the next compile pass uses this as a thread boundary |
| `session-end.mjs` | Stop / SessionEnd (each platform) | Marks session complete; optionally triggers an async compile pass via spawned subprocess |
| `error-handler.mjs` | wrapped around every other script | On any error from the above, writes `<timestamp> <hook> <error>` to `errors.log` and exits 0 (never breaks the host session) |

All scripts are stateless Node.js — they read JSON from stdin (the platform's hook payload), append to files, exit. No persistent state. No HTTP. No daemon.

**Atomicity:** all file writes use `fs.appendFile` (append-only) or atomic rename (write to `<file>.tmp`, then `rename`). Concurrent hooks across platforms cannot corrupt each other because each writes to its own `<tool>-<session>.md` file.

### 5.2 Platform manifests

Three thin manifest files, one per platform, all pointing at the same scripts:

`scripts/manifests/claude-code.hooks.json`:
```json
{
  "hooks": {
    "SessionStart":      [{ "hooks": [{ "type": "command", "command": "node ~/.memory/scripts/session-start.mjs" }] }],
    "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "node ~/.memory/scripts/prompt-submit.mjs" }] }],
    "PostToolUse":       [{ "hooks": [{ "type": "command", "command": "node ~/.memory/scripts/post-tool-use.mjs" }] }],
    "PreCompact":        [{ "hooks": [{ "type": "command", "command": "node ~/.memory/scripts/pre-compact.mjs" }] }],
    "Stop":              [{ "hooks": [{ "type": "command", "command": "node ~/.memory/scripts/session-end.mjs" }] }]
  }
}
```

Codex and Antigravity get analogous manifests adapted to each platform's hook event names. (Antigravity event names confirmed at implementation time against current `antigravity.google/docs` — they inherit from Gemini CLI's hook system.)

### 5.3 Event identification

Each platform sets one env var so the scripts know who called them:

- Claude Code sets `CLAUDECODE=1` natively
- Codex sets `CODEX_AGENT=1` (or detects via parent process)
- Antigravity sets `ANTIGRAVITY_AGENT=1`

Scripts read these to populate the `source` frontmatter field and the filename prefix (`<tool>-<session>.md`).

### 5.4 Error visibility

Per principle "errors are loud": every hook script is wrapped:

```js
try {
  await main();
} catch (err) {
  fs.appendFileSync(
    path.join(memoryDir, "errors.log"),
    `${new Date().toISOString()} ${HOOK_NAME} ${err.message}\n${err.stack}\n\n`
  );
}
process.exit(0);  // never break the host session
```

If memory ingestion stops working, `tail ~/.memory/errors.log` shows the user what happened in plain text. No daemon process to check, no API to ping, no doctor diagnostic — just a text file.

---

## 6. Ingestion — active (MCP server)

### 6.1 Purpose

Hooks capture the firehose. MCP gives the LLM a way to *deliberately* save and retrieve memory when the conversation calls for it. Example: user says "remember that the iii-config.yaml port hardcoding is the real cause" — the LLM calls `memory.log_observation` directly with that text + appropriate tags, instead of relying on it being parseable from the prompt firehose.

### 6.2 Transport

**Stdio MCP only.** No HTTP, no ports, no listening. The MCP server is a Node process spawned by each tool when the user opens a session; it dies when the tool closes. Cannot orphan. Cannot conflict with another instance.

### 6.3 Tools exposed

The MCP server exposes exactly these tools (intentionally small surface):

| Tool | Input | Output |
|---|---|---|
| `memory.log_observation` | `{ text: string, tags?: string[], confidence?: number }` | `{ path: string, ts: string }` — written to `raw/<date>/<tool>-<session>.md` under `## Observation` heading |
| `memory.search` | `{ query: string, k?: number, scope?: "wiki" \| "raw" \| "both", min_score?: number }` | `{ results: [{ path, snippet, score, type }, ...] }` — runs ripgrep + embedding cosine + frontmatter graph traversal, fused with reciprocal rank fusion |
| `memory.read_page` | `{ path: string }` | `{ frontmatter: object, content: string, relations_resolved: object }` |
| `memory.list_pages` | `{ type?: string, tag?: string, status?: string }` | `{ pages: [{ path, title, summary, updated }, ...] }` |
| `memory.compile` | `{ since?: string, scope?: string }` | spawns the compile workflow as a subprocess and returns the digest; see §8 |
| `memory.lint` | `{}` | `{ contradictions, orphan_pages, stale_claims, broken_links }` |
| `memory.crystallize` | `{ thread: string \| string[] }` | spawns the crystallize workflow; produces a digest under `crystals/` |
| `memory.stats` | `{}` | `{ total_pages, by_type, last_updated, embeddings_coverage }` |

### 6.4 Implementation

Single Node file (`scripts/mcp-server.mjs`) using `@modelcontextprotocol/sdk`. Stateless. Every call reads the current state from disk, computes, writes if needed, returns. No in-memory cache that could go stale.

### 6.5 Platform registration

Each platform's MCP config gets one entry:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["~/.memory/scripts/mcp-server.mjs"]
    }
  }
}
```

This is added to:
- Claude Code's `~/.claude/.mcp.json` (or per-project `.mcp.json`)
- Codex's `~/.codex/config.toml` under `[mcp_servers.memory]`
- Antigravity's `mcp_config.json` via the Agent pane

---

## 7. Retrieval — the four-tier model

When any LLM needs to recall memory, it picks the cheapest tier that answers the question.

| Tier | Mechanism | When |
|---|---|---|
| **1. Exact** | `rg <term> ~/.memory/` via Bash | Known strings, filenames, error codes, specific PIDs |
| **2. Index** | Read `index.md` directly | "What does the wiki know about X?" — LLM scans index, picks pages |
| **3. Semantic** | `memory.search` MCP call | Conceptual queries with no exact-string anchor |
| **4. Synthesis** | LLM reads top-N results from tiers 1-3 and composes the answer | Always; tiers 1-3 are retrieval, tier 4 is generation |

**Hybrid scoring in tier 3:** the `memory.search` tool combines:
- BM25 over wiki page text (via simple in-process implementation, no external service)
- Cosine similarity over `wiki.embeddings.jsonl` (loaded into memory on call, ~MB-scale)
- Frontmatter graph traversal (expand from top BM25 hits along `relations`)

Then reciprocal rank fusion (RRF) merges. RRF is the same fusion agentmemory uses internally and is the 2026 best-in-class for combining heterogeneous retrievers (LongMemEval).

### 7.1 Embeddings layer

`embeddings/wiki.embeddings.jsonl` is JSON-lines, one record per wiki page:

```
{"path": "wiki/projects/agentmemory.md", "hash": "<sha256>", "vector": [...], "model": "voyage-3-large", "ts": "..."}
```

- **Provider:** configurable in `config.yaml`. Default: Voyage AI **`voyage-3.5`** ($0.06/M tokens, beats OpenAI `text-embedding-3-large` by ~8% on retrieval per Voyage's published evals, 32K context window, supports Matryoshka dimensions 2048/1024/512/256 for speed/storage tuning). Verified current via web search 2026-05-20. Alternates: OpenAI `text-embedding-3-small` ($0.02/M, safe default), Voyage 4 family (MoE, January 2026), Cohere `embed-v4` (slight MTEB lead at 65.2 vs voyage-3-large's 65.1). Optional local-only mode via Ollama + `nomic-embed-text` for offline use.
- **Refresh:** lazy. On `memory.search`, the MCP server computes the SHA256 of each wiki page; any pages whose hash doesn't match the JSONL entry get re-embedded. Stale entries are removed. This means embeddings stay current automatically with no scheduled job.
- **Cost ceiling:** the first wiki build costs N × 1k tokens × $0.18/M ≈ a few cents for a few hundred pages. Incremental refresh is near-free.

### 7.2 No vector DB

The JSONL file is loaded fully into memory per query. At 1024-dim float32, 10000 pages = 40 MB. Cosine similarity over 10000 vectors is ~1ms. There is no scenario in personal-scale use where this needs a real vector DB.

### 7.3 Graph memory — first-class layer

The knowledge graph is derived on-demand from frontmatter `relations:` blocks AND inline `[[wikilinks]]` across all wiki pages. Zero-bytes incremental storage — the graph IS the markdown.

**Edge types** (defined authoritatively in `schema.md`):

| Type | Direction | Semantics |
|---|---|---|
| `uses` | A → B | A is a project/system that uses B (a tool/library) |
| `depends_on` | A → B | A's functioning requires B |
| `supersedes` | A → B | A replaces B (B archived) |
| `contradicts` | A → B | A's content disagrees with B; needs human resolution |
| `caused_by` | A → B | A (problem/event) was caused by B |
| `fixed_by` | A → B | A was fixed by B (decision/commit/lesson) |
| `derived_from` | A → B | A's content was distilled from B (e.g., crystal from raw thread) |
| `mentioned_in` | A → B | A appears in B (often auto-extracted) |
| `linked` | A → B | Generic association; least specific. Inline `[[wikilinks]]` create implicit `linked` edges. |

**Graph operations exposed via MCP and CLI:**

| Operation | Purpose |
|---|---|
| `memory.graph_query({ start, depth, types })` | Returns the typed neighborhood of a starting node |
| `memory.graph_stats()` | Degree distribution, most-connected nodes, orphans (no inbound or outbound edges) |
| `memory.graph_path({ from, to, max_depth, types? })` | Shortest typed path between two nodes |
| `memory.graph_export({ format })` | Dump as JSON / GraphML / Obsidian Canvas for external tools |

**Two population paths:**

1. **Explicit** (Phase 1+) — frontmatter `relations:` written by the LLM (or human) at page creation/update time. High precision, lower recall. Default.
2. **Implicit** (Phase 6+, opt-in) — LLM compile pass scans raw observations for entity mentions and proposes new edges. Proposals land in `~/.memory/relations-proposals.md` for human/lint review before merging. Lower precision; user gates the merge. Disabled by default; enabled via `config.yaml: graph.implicit_extraction: true`.

**Graph traversal in retrieval** (already mentioned §7 — making it explicit here): tier-3 search fuses BM25 + embedding cosine + 1-hop graph expansion from BM25 top-K, then RRF over all three. This is the same multi-signal fusion agentmemory's worker uses internally (scored 95.2% on LongMemEval — see [[references/karpathy-llm-wiki-pattern]]).

**Visualization is Obsidian Graph View** (per §4.6). No custom visualizer to build. Both `[[wikilinks]]` and frontmatter relations render as edges; filters work by tag and folder. The user's "graph memory" requirement is satisfied at zero implementation cost for visualization.

**Performance:** loading the full graph means scanning all `wiki/**/*.md` frontmatter on each MCP call. At 5000 pages this is ~100ms first call, sub-1ms cached per-session. The MCP server caches the parsed graph in-process per call; a session that issues multiple graph queries reuses the parse.

---

## 8. Curation — compile / lint / crystallize

These are LLM-driven workflows, not background jobs. They run when the user (or a session-end hook) invokes them.

### 8.1 Compile

**Trigger:** `memory.compile` MCP call, or `~/.memory/scripts/compile.sh` from a session-end hook, or the user typing `/memory-compile` in their agent.

**What it does:**

1. Reads recent files under `raw/` (since last compile, tracked in `log.md`).
2. For each session file: extracts entities (projects, decisions, lessons, references), summarizes the thread, identifies new facts.
3. For each entity: updates the corresponding `wiki/<type>/<slug>.md` page, preserving existing content. Appends a `## YYYY-MM-DD update` section if material changed.
4. Updates `index.md` if pages were added or titles changed.
5. Appends a `## [YYYY-MM-DD HH:MM] compile | N raw sessions → M wiki updates` line to `log.md`.
6. Returns a digest to the caller.

**Implementation:** `compile.sh` is a shell wrapper that calls whichever LLM is configured (default: the user's current Claude/Codex/Antigravity session) with a structured prompt. The prompt template lives in `~/.memory/scripts/prompts/compile.md`. The LLM does the actual work; the script just orchestrates the file reads/writes.

### 8.2 Lint

**What it checks:**
- Pages whose `relations.contradicts` references resolve to other pages → flag for human review
- Pages with no inbound links from any other page (orphans) → flag
- Pages with `updated > 90 days ago` AND `status: active` → flag as potentially stale
- `[[wiki/X]]` references that don't resolve → flag as broken
- Frontmatter validation: required fields, valid types, valid status values

**Output:** writes `~/.memory/lint-report.md` with sections per issue type. The user reads it, decides, edits. No automatic fixes.

### 8.3 Crystallize

**Purpose:** Wiki v2's addition over Karpathy's original. Distill a completed work thread (e.g., this whole `codex/windows-codex-desktop-stability` session) into a long-form digest.

**Trigger:** explicit only — `memory.crystallize { thread: "..." }` or `/memory-crystallize`.

**Output:** a single `crystals/<YYYY-MM-DD>-<slug>.md` page that captures:
- What problem was being worked
- What approaches were tried
- What worked, what didn't, what's still open
- Links to all wiki pages updated as part of the thread
- The "next time you face this" recap

**Why separate from compile:** compile keeps the wiki current incrementally; crystallize creates intentional long-form digests that won't be touched again unless the user re-crystallizes. Crystals are the high-confidence, narrative-driven "stories" the user can re-read months later.

---

## 9. CLI surface

A single `memory` binary (Node) under `~/.memory/scripts/cli.mjs`, installed on PATH via npm-link or a small install script.

```
memory init                          Set up ~/.memory/ structure, write schema.md template
memory install <platform>            Wire hooks + MCP into Claude Code / Codex / Antigravity
memory search "<query>" [-k N]       Tier-3 retrieval; same backend as MCP
memory compile [--since DATE]        Run the compile workflow
memory lint                          Run the lint workflow
memory crystallize <thread>          Run the crystallize workflow
memory stats                         Page counts, embedding coverage, last activity
memory doctor                        Verify hook installation, MCP registration, recent activity
memory tail-errors                   `tail -f errors.log` shortcut
memory backup                        git commit + (optional) push to remote
memory page <path>                   Pretty-print a wiki page with resolved relations
memory import-from-agentmemory       One-shot migration (see §10)
```

Each subcommand exits non-zero on failure with a clear error message. No subcommand starts a long-running process. No subcommand binds a port.

---

## 10. Migration from agentmemory

The user's existing memories live at `C:\CodexProjects\agentmemory\data\state_store.db\` (after slice 12's restore) — specifically:
- `mem%3Amemories.bin` (460 bytes, ~1 memory)
- `mem%3Asummaries.bin` (1508 bytes, summaries)
- `mem%3Aindex%3Abm25.bin` (479 KB, BM25 index)
- `mem%3Aobs%3A*.bin` (observation files, JSON content per slice 11 forensics)
- `mem%3Aslots*.bin` (slot content)

These are URL-encoded keys over a custom-formatted binary store. Migration approach:

### 10.1 One-shot extractor

`memory import-from-agentmemory` does:

1. Reads the binary `.bin` files using agentmemory's existing parser (vendored from `src/state/kv.ts` — small, self-contained).
2. For each observation: extracts the JSON payload, derives a session ID from the filename, writes it to `~/.memory/raw/<observation-date>/migrated-<obs-id>.md` with appropriate frontmatter.
3. For each slot: writes to a new wiki page `wiki/slots/<label>.md` with the slot content preserved.
4. Skips the BM25 index entirely — we'll regenerate from the imported raw observations.
5. Calls `memory compile` to turn the imported raws into curated wiki pages.

### 10.2 Migration is one-time, not ongoing

After this runs once, the agentmemory store is no longer referenced. The `C:\CodexProjects\agentmemory\` directory can be archived or left alone. The user can delete it whenever comfortable; the C:\Backups snapshot remains as last-resort rollback.

### 10.3 Verification

Post-migration, `memory stats` reports the imported counts. The user reviews. If anything looks wrong, the imported raws + the C:\Backups snapshot allow re-running the migration with different parameters.

---

## 11. Failure mode review — session findings vs new design

| Failure that bit this session | Why it can't happen here |
|---|---|
| Slice 2 — Variant B: dead PID holds sockets after force-kill | No daemon, no sockets. Hooks die instantly with the host. |
| Slice 3 — stop orchestration treats dead pidfile as live survivor | No pidfiles. No supervisor. No stop command. |
| Slice 4 — `npm run build` dirties tracked plugin scripts via CRLF/LF churn | No build step on the memory side; scripts are committed as written. (`.gitattributes` is still a good idea for cross-platform.) |
| Slice 5 — test totals format ambiguous | Single test target; vitest config emits `failed | passed | skipped | todo` natively when invoked correctly. |
| Slice 6 — `agentmemory start` silently routes to main() | No subcommand dispatcher with implicit fallbacks. The `memory` CLI uses commander-style strict-mode where unknown subcommands exit 2. |
| Slice 7 — `personalize --apply` lies about no-ops | Slot/page writes are content-addressed; the CLI logs `prior bytes → new bytes (delta)` per write. |
| Slice 8 — `passiveServerChecks` decision logic untested | No `passiveServerChecks`. `memory doctor` is a pure function of filesystem state, trivially testable. |
| Slice 9 — command-center negative paths untested | No command-center. `memory stats` is pure read; lint emits structured output that's tested per failure mode. |
| Slice 10 — stale dead-PID port detection | No ports to be stale. |
| Slice 12 — repo relocation orphaned the data dir because of cwd-relative `iii-config.yaml` | `~/.memory/` is absolute. Not cwd-coupled to anything. Relocate any source repo freely. |
| Slice 13 — iii-config.yaml hardcoded ports defeat env-var workaround | No iii-config.yaml. No ports. |
| Pre-design — "I don't see Claude memories in agentmemory" because hooks silently swallow errors | Hooks here write `errors.log` on any failure; `memory tail-errors` surfaces them. |
| Slice 1 — onboarding triggers on fresh data dir | No interactive onboarding. `memory init` is non-interactive and idempotent. |

### 11.1 New failure modes possible + mitigations

| New failure | Mitigation |
|---|---|
| Hook fires while disk is full | Hook writes fail; `errors.log` records; host session continues. User notices on next `memory doctor`. |
| Two platforms write to the same raw file simultaneously | Filenames include `<tool>-<session-id>` so writes are disjoint by design. |
| Compile workflow corrupts a wiki page mid-write | Atomic rename pattern: write to `<page>.tmp`, then `rename`. Git provides one-step undo. |
| Embedding provider API outage | `memory search` falls back to BM25 + graph-only with a warning printed once. |
| Embedding model changed (re-embed everything) | The JSONL records `model`; mismatched-model rows are re-embedded lazily. |
| Wiki grows past comfortable grep size (~10K pages?) | Index.md should be split by category at that point; lint warns when index.md > 1000 lines. |
| User edits a wiki page manually, breaking frontmatter | Lint catches frontmatter validation errors. Pre-commit hook (optional) blocks bad frontmatter from being committed. |
| Schema.md changes mid-flight, breaking existing pages | Schema is a single file; changes are reviewed by the user via `git diff`. Compile uses schema.md as it is at compile time — old pages aren't auto-migrated. |
| `~/.memory/.git/` corrupts | Push to a remote regularly (`memory backup`). Disaster recovery = clone the remote. |

---

## 12. Project structure

The implementation lives at `C:\CodexProjects\memory-system\` (matches existing CodexProjects convention, not under OneDrive):

```
C:\CodexProjects\memory-system\
  package.json                                 ← deps: @modelcontextprotocol/sdk, commander, gray-matter, voyage-ai-sdk
  README.md
  src/
    cli.ts                                     ← memory CLI entry
    mcp-server.ts                              ← MCP server entry
    hooks/
      session-start.ts
      prompt-submit.ts
      post-tool-use.ts
      pre-compact.ts
      session-end.ts
      error-handler.ts
    curation/
      compile.ts
      lint.ts
      crystallize.ts
    retrieval/
      bm25.ts
      embeddings.ts
      graph.ts
      fusion.ts
    storage/
      paths.ts                                 ← all path resolution centralized here
      frontmatter.ts                           ← read/write YAML frontmatter
      atomic-write.ts                          ← write-to-tmp + rename
    migrate/
      agentmemory-import.ts
    config.ts
  scripts/
    install.sh                                 ← `memory install` impl
    prompts/                                   ← LLM prompt templates for compile/lint/crystallize
      compile.md
      lint.md
      crystallize.md
  test/
    cli.test.ts
    mcp.test.ts
    hooks.test.ts
    curation.test.ts
    retrieval.test.ts
    migrate.test.ts
  docs/
    superpowers/
      specs/
        2026-05-20-cross-tool-memory-system-design.md   ← this file
      plans/
        (implementation plan added next)
    architecture.md                            ← user-facing architecture page
    cli.md                                     ← user-facing CLI reference
  .gitattributes                               ← LF for .mjs/.cjs scripts (slice 4 lesson)
  .gitignore                                   ← excludes node_modules, dist/, errors.log
  tsconfig.json
  vitest.config.ts
```

**Build target:** TypeScript → ESM via `tsdown` (same toolchain as agentmemory, proven on this user's Windows). Output `dist/*.mjs` files are what get referenced from `~/.memory/scripts/` via the `memory install` step.

**Dependencies (minimum):**
- `@modelcontextprotocol/sdk` — MCP server
- `commander` — CLI parsing
- `gray-matter` — YAML frontmatter parsing
- `js-yaml` — frontmatter writing
- One embedding SDK (Voyage default, fallback OpenAI)
- `vitest` — testing

No: database, web framework, daemon library, port management library.

---

## 13. Testing strategy

Adopt the lessons from slices 5, 8, 9 — bias toward unit tests of pure decision functions, exercised across positive AND negative paths.

### 13.1 Unit-tested pure functions

- `frontmatter.parse`, `frontmatter.serialize` (round-trip)
- `bm25.score`, `bm25.tokenize`
- `embeddings.cosine`
- `fusion.reciprocalRankFusion`
- `paths.resolveWikiPath`, `paths.parseRelation`
- `lint.checkOrphans`, `lint.checkContradictions`, `lint.checkStale`
- Migration extractor: given known `.bin` content, produces expected markdown

### 13.2 Integration tests

- Hook scripts: feed mock JSON to stdin, assert file contents written
- MCP server: spawn via test harness, exercise each tool, assert responses
- Compile: with a fixed prompt-template + mocked LLM, assert that given raw inputs produce expected wiki updates
- End-to-end migration: run against a snapshot of the user's actual agentmemory backup, assert all 33 source files produce expected raw observations

### 13.3 Test totals format

Adopt slice 5's four-category output (`failed | passed | skipped | todo`) from day one. No ambiguity.

### 13.4 No live-daemon test

The system has no daemon, so there is no "daemon-up integration test" to design around. This was the entire source of friction in the agentmemory test setup; gone here.

---

## 14. Implementation phases

### Phase 1 — Foundation (smallest deliverable)
- Storage layout + `memory init`
- Hook scripts (session-start, prompt-submit, post-tool-use, session-end, error-handler)
- Platform manifest generation in `memory install <platform>`
- Claude Code wiring only (Codex + Antigravity in Phase 4)
- No MCP yet, no compile yet, no embeddings yet
- **Acceptance:** hooks fire, raw files appear, `memory stats` reports counts

### Phase 2 — Curation
- `compile.sh` + prompt templates
- `memory compile` CLI subcommand
- `index.md` and `log.md` updates
- `lint` workflow + `memory lint`
- Frontmatter validation
- **Acceptance:** running `memory compile` against Phase 1's accumulated raw output produces a curated wiki

### Phase 3 — Retrieval, MCP, and graph layer
- BM25 implementation
- Embeddings layer (Voyage `voyage-3.5` + JSONL sidecar + lazy refresh)
- Frontmatter graph parsing + in-memory typed-graph structure
- Graph query operations (`memory.graph_query`, `memory.graph_stats`, `memory.graph_path`)
- Reciprocal rank fusion across BM25 + vector + 1-hop graph expansion
- MCP server with all ~11 tools (the 8 base + 3 graph)
- Claude Code MCP registration
- **Acceptance:** `memory search "X"` returns RRF-fused results; `memory.graph_query` returns typed neighborhoods; Obsidian Graph View renders the same edges the MCP server reports

### Phase 4 — Cross-platform + crystallize
- Codex hooks manifest + MCP registration
- Antigravity hooks manifest + MCP registration
- Crystallize workflow + `memory crystallize`
- **Acceptance:** observations from all three platforms land in the same `~/.memory/`, queryable via search; user can crystallize a thread

### Phase 5 — Migration
- `memory import-from-agentmemory`
- Run against the user's restored OneDrive store
- Run `memory compile` on imported raws
- Verify
- **Acceptance:** the user's existing agentmemory content is queryable via `memory search` from any of the three platforms

### Phase 6 — Polish, Obsidian verification, retention, optional implicit graph
- `memory doctor` checks (verify hook installation, MCP registration, recent activity, errors.log size, retention pass overdue)
- `memory backup` (git commit + push)
- `memory retain --apply` retention pass + scheduled-task installer
- Obsidian vault verification — load `~/.memory/` in Obsidian, confirm Graph View / Backlinks / Dataview all work against our schema
- Documentation (architecture.md, cli.md, obsidian-setup.md)
- `.gitattributes` for cross-platform line-ending hygiene per slice 4 lesson
- **Optional (opt-in via `config.yaml`):** implicit graph extraction during compile — LLM proposes new edges; proposals land in `relations-proposals.md` for human/lint review
- **Acceptance:** the system is documented well enough for the user to operate it without re-reading this spec; retention runs cleanly on a 90-day-old raw/ dataset; Obsidian opens the vault and shows a non-empty Graph View

Each phase ships its own commit on its own branch, gets its own implementation plan via `writing-plans`, and ends with verification before the next phase starts.

---

## 15. Non-goals

Explicit out-of-scope to prevent scope creep:

- Multi-user / shared memory
- Cloud sync (other than the user's existing git remote habit)
- Real-time dashboard / web UI (Obsidian gives free GUI if wanted)
- A web server / REST API of any kind
- Daemon / always-on processes
- Custom search engine implementation beyond minimal BM25
- Replacing CLAUDE.md (the schema.md complements it; CLAUDE.md remains for tool-specific config)
- A standalone graph database engine like Neo4j (the graph is derived from frontmatter on-demand — we DO have graph operations and queries, just no separate DB engine)
- Maintaining backward compatibility with agentmemory's HTTP API
- Multi-machine sync beyond what `git pull` / `git push` provide
- A "team" feature
- A "leases" or "actions" or "frontier" feature (agentmemory has these; YAGNI for personal use)

---

## 16. Open questions for user review

These are decisions worth confirming before writing the implementation plan:

1. **Embedding provider default.** Voyage AI **`voyage-3.5`** (paid API, $0.06/M tokens, current best price/quality per May 2026 web verification) recommended. Alternates: OpenAI `text-embedding-3-small` ($0.02/M, lower-quality safe default), Ollama+nomic for offline. Does the user want a different default? (Note: my initial recommendation of voyage-3-large was corrected after user requested online grounding — voyage-3-large is superseded by voyage-3.5 at 1/3 the price.)
2. **Whether `raw/` is committed to git.** Default proposed: gitignored (privacy / size). Alternative: committed to give full audit trail with the cost of larger repo.
3. **Whether the system should consume Claude Code's session transcripts at `~/.claude/projects/.../*.jsonl` as a redundant ingestion path** (belt-and-suspenders against hook failures). Adds complexity but provides recovery if hooks ever silently break.
4. **The implementation language.** TypeScript+ESM matches the existing agentmemory toolchain and is portable. Alternative: a single Bash + Python toolchain to drop the npm dependency entirely. TypeScript proposed for type safety and ecosystem.
5. **Crystallize scheduling.** Manual only (proposed) vs. on every session-end (more automation, less control).
6. **Auto-commit-and-push policy.** `memory backup` is explicit by default. Should `memory compile` also auto-commit? Proposed: no — keep human in the loop for what enters version history.

---

## 17. Acceptance criteria — when this design is "done"

A design is implementable when:

1. Every section above survives reading by a new contributor without follow-up questions about scope, naming, or structure.
2. Each phase's "Acceptance" line is concrete and testable.
3. The failure mode review accounts for every concrete failure documented in `project_agentmemory.md`.
4. The non-goals list pre-empts likely scope creep.
5. The open questions are bounded — no more than ~6, each binary or short-answer.

This design satisfies all five.

---

## Appendix A — references

- Andrej Karpathy, "LLM Wiki" (April 2026): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- "LLM Wiki v2" (April 2026, agentmemory lessons): https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2
- Karpathy LLM Wiki overview (Intelligent Living, April 2026): https://www.intelligentliving.co/karpathy-llm-wiki-markdown-knowledge-base/
- VentureBeat coverage (April 2026): https://venturebeat.com/data/karpathy-shares-llm-knowledge-base-architecture-that-bypasses-rag-with-an
- Antigravity MCP docs: https://antigravity.google/docs/mcp
- Antigravity 2.0 launch (MarkTechPost, May 2026): https://www.marktechpost.com/2026/05/19/google-launches-antigravity-2-0-at-i-o-2026-a-standalone-agent-first-platform-with-cli-sdk-managed-execution-and-enterprise-support/

---

## Appendix B — session context lineage

This design is informed by the work in `codex/windows-codex-desktop-stability` on `C:\CodexProjects\agentmemory\` over 2026-05-19 and 2026-05-20. The 8 commits there (`2793bd2` → `c16af42`) fixed real defects in agentmemory and produced lessons-learned that are referenced throughout this design (especially §11). The agentmemory codebase remains valid and continues to exist; this design covers the user's *personal-use migration*, not a deletion of agentmemory.

The user's memory project at `C:\Users\Admin\.claude\projects\C--\memory\` was updated during the session and contains:
- `project_agentmemory.md` — the lessons about the daemon architecture
- `reference_codex_project_routing.md` — Codex cwd routing
- `feedback_codex_prompts.md` — Codex prompt conventions (online-grounded, meta-prompt structure)

These memory files inform this design's stance on what to inherit vs. discard from agentmemory.
