# CLI reference

`memory <subcommand> [options]` — single binary at `dist/cli.mjs`, installed as `memory` on PATH via npm-link, or run `node dist/cli.mjs` directly.

> This reference tracks the live command tree in `src/cli.ts` + `src/cli/commands/`. Stubs (not yet implemented) are listed at the end and exit non-zero.

---

## Setup & integration

### `memory init [--reset]`
Lay out `~/.memory/`: `schema.md`, `index.md`, `log.md`, `config.yaml`, `wiki/` (incl. seeded `wiki/preferences.md` and category directories such as `wiki/issues/`), `raw/`, `.gitignore`, and `git init`. `--reset` archives the existing vault first.

### `memory install <platform> [--workspace <dir>] [--surface <s>] [--no-verify]`
Install hooks + the `memory` MCP server for one platform: `claude-code` | `codex` | `antigravity` | `claude-desktop` | `vscode`. Edits shared config files between `# === BEGIN/END memory-system ===` sentinel markers. Runs `verify --role operator` afterward unless `--no-verify`.

### `memory connect [client] [--all] [--workspace <dir>] [--no-verify]`
Install MCP/hooks for one client or, with `--all`, every detected client. Convenience wrapper over `install`.

### `memory install-vps [--ssh-host <host>] [--install-root <path>] [--dry-run]`
Lay out `/root/memory-system/` on the VPS over SSH (idempotent): `services/` (dashboard bundle), `dist/dashboard-ui/`, `env/` (chmod 0600), the `memory.git` bare repo + post-receive checkout hook, and the hardened `memory-dashboard.service` + `memory-backup.{service,timer}` systemd units. `--dry-run` prints the SSH commands.

### `memory install-tailscale-route [--ssh-host <host>] [--dashboard-port <n>] [--path-prefix <p>] [--dry-run]`
Add a `tailscale serve <path> → http://127.0.0.1:<port>` route on the VPS, preserving existing routes.

### `memory sync-bootstrap [--remote-name <n>] [--ssh-host <h>] [--vps-install-root <p>] [--branch <b>] [--skip-initial-push]`
Configure `~/.memory/` to use the hosted bare repo as a git remote, install the post-receive hook, and do an initial push. The default remote name remains the legacy `vps`; pass `--remote-name whitedragon` when using the Whitedragon mirror.

### `memory dashboard [--port <n>] [--host <h>] [--root <path>] [--no-open]`
Serve the dashboard locally against the canonical writable vault (`--root`, `MEMORY_ROOT`, or `~/.memory`). Defaults to `127.0.0.1:4410`, prints `http://127.0.0.1:<port>/memory/` plus the selected vault root, opens a browser unless `--no-open`, and uses the local shell environment for `VOYAGE_API_KEY`, `OPENROUTER_API_KEY`, and `OLLAMA_HOST`. Run `npm run build:ui` first so `dist/dashboard-ui` exists.

---

## Memory operations

### `memory search <query> [--scope wiki|raw|crystals|all] [--k <n>] [--min-score <n>] [--no-rerank] [--json] [--dashboard-url <url>] [--vps-url <url>]`
Query the configured dashboard `/api/search`; prints ranked results with provenance. Resolution order is `--dashboard-url`, legacy `--vps-url`, `dashboard.url` in `config.yaml`, legacy `vps.host`, then the local dashboard at `http://127.0.0.1:4410/memory`. Defaults to the fast `--no-rerank` path for bounded latency; omit it to add Voyage rerank. Runs no retrieval locally.

### `memory compress [--plan|--apply] [--drain] [--max-sessions <n>]`
Compress raw sessions once into structured fact bundles under `facts/YYYY-MM-DD/<session>.json`. Each fact bundle has `title`, `facts[]`, `narrative`, `concepts[]`, `files[]`, `importance` (1-10), `sessionId`, and `observedAt`. Apply mode advances `state/compile-state.json.compressed` so already-compressed sessions are skipped; `--drain` repeats bounded batches until no uncompressed sessions remain.

### `memory compile [--since <date>] [--per-file-max-bytes <n>] [--total-max-bytes <n>] [-o|--output <path>] [--execute] [--plan] [--drain --max-passes <n>]`
Assemble the consolidation prompt from raw observations since the last compile.
- **Default (artifact mode):** prints the rendered prompt to stdout, or to `--output <path>` if given, for an agent to execute.
- **`--execute`:** when compressed facts exist, synthesize knowledge pages from the fact store, not raw transcripts. Facts are grouped by concept, low-importance bundles are ignored, each concept uses the top importance-scored bundles, and the run is capped at the fact-consolidation LLM call limit. If no fact store exists, the legacy fenced `compile-ops` executor remains as a compatibility path.
- **`--execute --plan`:** preview the operations without writing.
- **Existing page state:** the rendered prompt includes current wiki page bodies within a byte budget for artifact compatibility. In fact-backed execute mode, existing durable knowledge pages are updated from pre-compressed facts only. The write-back path asks for structured novelty detection (`contradicted_claims`, `net_new_facts`) and then synthesizes one narrative body. Redundant pages are skipped and counted as unchanged.
- **Provider compatibility:** narrative synthesis requires JSON-schema structured output for the detect/synthesize responses.
- **Prompt provenance:** uncustomized vault prompts are loaded template-first from the bundled `templates/prompts/` copy. A vault prompt with `# memory:custom` is treated as intentional customization. If a stale uncustomized vault prompt lacks the current template sentinel, compile warns and points to `memory sync-prompts --apply`.
- **Rewrite safety:** narrative synthesis validates that knowledge-page bodies contain no headings, lists, checklists, code fences, or tables. Successful rewrites archive the prior page under `wiki/.history/`, increment `version`, append `supersedes`, stamp `last_accessed`, default `strength`, and record `source_facts`. Invalid syntheses stage under `wiki/compile-proposed/`.
- **Index rebuild:** after a successful non-plan `--execute`, `index.md` is regenerated deterministically from canonical `wiki/` pages. The model no longer updates it directly.
- **Fairness window:** eligible raw files are ordered as never-consumed first, then oldest consumed watermark first. Compile allocates raw bytes in round-robin slices so a large active file can continue advancing without permanently crowding out smaller files.
- **`--execute --drain [--max-passes <n>]`:** repeatedly runs execute-mode compile until a pass includes no raw files, or until the max-pass guard is reached (default 50). Each pass prints included files, advanced watermarks, and remaining raw bytes/files.

### `memory reindex [--plan]`
Regenerate `index.md` deterministically from the canonical `wiki/` tree. Pages are grouped by type, sorted within each section, deduplicated by path, and operational spaces such as `.audit/`, `*-proposed/`, and `archive/` are excluded. `--plan` reports whether the index would change without writing.

### `memory sync-prompts [--plan|--apply]`
Refresh uncustomized vault prompts from bundled templates. `--plan` is the default and reports `copy`, `unchanged`, or `skip-custom`; `--apply` copies templates into `prompts/` but never overwrites files containing a `# memory:custom` marker.

### `memory curate <page> [--plan|--apply] [--refresh]` / `memory curate --all [--plan|--apply] [--refresh]`
Ask the configured LLM to consolidate a bloated wiki page into one coherent article and apply the result as a guarded rewrite. `--plan` is the default and previews without writing; `--apply` archives the prior page and applies rewrites that preserve salient anchors. Bare slugs such as `agentmemory` resolve across `wiki/<category>/<slug>.md`; ambiguous slugs list matches. Without `--refresh`, `--all` targets pages over the dated-section threshold (`--section-threshold <n>`, default 8).

`--refresh` reads matching compressed facts for the target page and runs the narrative synthesis path. Raw session text is not scanned or sent to the rewrite prompt. `--refresh-days <n>` controls the fact lookback window (default 14); `memory curate --all --refresh --apply` sweeps all canonical wiki pages, so use it as a one-time backfill or prefer a targeted page refresh when the stale pages are known.

### `memory compact-raw [--plan|--apply] [--max-input-bytes <n>] [--max-output-bytes <n>]`
Shrink oversized raw `ToolUse` payloads using middle-out truncation while preserving observation headings/counts. `--plan` is the default and reports reclaimable bytes per file. `--apply` copies originals under `raw/.compact-archive/<date>/`, rewrites only changed raw files, clamps any consumed compile watermark past the new EOF, and commits the touched vault paths. Defaults match capture caps: 8192 input bytes and 8192 output bytes.

### `memory consolidate [--plan|--apply] [--force] [--min-confidence <n>] [--max-links-per-observation <n>]`
Link raw episodic observations to existing wiki pages via deterministic matching (no LLM). `--plan` previews; `--apply` writes the relation edges.

### `memory link-raw [--plan|--apply] [--threshold <n>] [--title-threshold <n>] [--mass-collision-threshold <n>]`
Plan or apply automatic `mentions` links from orphan raw observations to existing wiki entity pages. The embedding strategy is used only when sidecar vectors pass the health guard: dimensions must be sane and match `embedding.dim` when configured, raw vectors must not be byte-identical to candidate wiki vectors, and the top candidates must not all score as 1.000-style collisions. With real Voyage `voyage-4-large` sidecars, the default embedding threshold is `auto_link.similarity_threshold: 0.65`; when embeddings are absent or degenerate, the command falls back to lexical title/alias/summary matching and applies `auto_link.title_threshold: 0.55`. In apply mode, the command plans first and refuses to write when more than `auto_link.mass_collision_threshold` (default `0.2`) of a non-trivial orphan corpus resolves to one non-exempt target.

Use `memory link-raw --plan` before any backlog write and read a sample of raw/wiki pairs from the plan output. If the sampled noise rate is above 20%, raise `--threshold` and re-run the plan. Legitimate catalog pages that naturally receive many mentions can be listed under `auto_link.exempt_hub_pages`; the default exemption is `wiki/references/mcp-servers-available.md`. Add at most a few explicit hubs after reading the matched raws. If many pages need exemption, prefer a dynamic hub policy instead of widening the list.

### `memory lint [--checks-only] [--stale-days <n>]`
With `--checks-only`, run programmatic wiki checks (frontmatter validity, broken links, advisory edge grammar). Without it, assemble a lint prompt for an agent.

### `memory page <target> [--no-inbound]`
Pretty-print a wiki page with resolved relations and inbound references.

### `memory log "<text>" [--tag X --tag Y] [--confidence 0..1]`
Append a deliberate observation to today's raw file (commits the raw file). Surfaces back at session-start and in lexical search.

### `memory grep <pattern> [--scope raw|wiki|both] [-C <n>]`
ripgrep over the vault with context lines.

---

## Consolidation (review-gated)

### `memory thread propose [--plan|--apply] [--auto-promote] [--days <n>] [--max-proposals <n>]`
Cluster raw observations (Jaccard ≥0.5 over entities, 7-day window, ≥3 obs) and draft LLM narrative-thread proposals into `wiki/threads-proposed/`. `--auto-promote` promotes high-confidence drafts directly.
### `memory thread promote <slug>` / `memory thread reject <slug>`
Move a reviewed draft to `wiki/threads/` (promote) or archive it (reject). Both commit the vault change.

### Wiki reasoning-edge activation runbook
Use this when `/api/graph-health` reports isolated wiki pages in `graph.participation-rate`. The metric counts only reasoning edges (`uses`, `depends_on`, `caused_by`, `fixed_by`, `contradicts`, `supersedes`, `learned_from`, `tested-with`), not raw `mentions` or wikilinks.

1. Enumerate isolated pages from the same corpus/graph feed used by the dashboard, and classify every page as `link-candidate`, `thread-candidate`, `genuine-standalone`, `test-fixture`, or `archive-candidate`. Read title, `type`, `lifecycle`, `tags`, and body before classifying.
2. Propose the smallest honest edge set. Prefer intra-cluster links between related isolated threads or lessons when direct project edges would inflate a project's 2-hop neighborhood and lower `graph.project-subgraph-density`.
3. Before applying, sample at least five proposed edges and read source/target excerpts. Do not apply if the sampled noise rate is above 20%; tighten the set instead.
4. Apply relation edits as frontmatter changes only. Archive test fixtures or smoke markers under `wiki/.archive/<reason>/<date>/` with `status: archived`, `lifecycle: archived`, and a one-line archive note. Do not permanently delete fixture pages.
5. Re-read `/api/graph-health` and `/api/search` after applying. Required checks: participation rate rises, overall status remains `pass`, `graph.project-subgraph-density` does not newly warn, orphan rate does not regress materially, search has `refreshMs: 0`, rerank is active when expected, and the response is not degraded.
6. Roll back a bad edge by removing the added relation block from the source page. Roll back an archive by moving the file from `wiki/.archive/...` back to its original `wiki/...` path and restoring `status: active` / the prior lifecycle from git history. There is no `graph.participation-rate` exemption config today; adding one is a metric-contract change and needs a separate brief.

### `memory procedure propose [--plan|--apply] [--auto-promote] [--days <n>] [--max-proposals <n>]`
Detect repeated command workflows (command-set Jaccard ≥0.4, ≥3 obs across ≥2 sessions) and draft procedures into `wiki/procedures-proposed/`.
### `memory procedure promote <slug>` / `memory procedure reject <slug>`
Promote/reject a procedure draft (commits the vault change).

### `memory entity dedup [--plan|--apply]`
Detect duplicate entity pairs (normalized-form + high-similarity match; `wiki/.audit/` excluded). `--plan` lists; `--apply` stages proposals.
### `memory entity merge <canonical>` / `memory entity reject <canonical>` / `memory entity aliases`
Merge rewrites relation targets to the canonical name and records `wiki/.entity-aliases.json` (never deletes); reject drops a proposal; aliases lists the map.

---

## Providers (embedder + LLM)

### `memory provider list-embedders` / `list-llms`
List supported providers + current config (no secrets).
### `memory provider test-embedder [--provider voyage|openai|ollama]` / `test-llm [--provider openrouter|ollama]`
Smoke-test a provider call (needs the relevant env key).
### `memory provider test-classifier "<query>"`
Run the query-intent classifier on one query; prints label, method, latency, tokens.
### `memory provider reindex-embeddings [--plan|--apply]`
Plan or apply an incremental embedding refresh (needs `VOYAGE_API_KEY` for the default Voyage provider in apply mode). Plan mode reports the full corpus count plus only the pending document count, pending token estimate, and pending cost. Without the key, vector calls fail and existing sidecars may be absent or stub-like depending on the caller; BM25 and graph retrieval still work, but vector retrieval and embedding-based auto-linking should be treated as inactive. Set `VOYAGE_API_KEY` in the environment, run `memory provider reindex-embeddings --plan` to inspect pending scope and estimated cost, then run `memory provider reindex-embeddings --apply`. Apply mode validates every new vector against the configured provider dimension and persists successful batches incrementally; a degraded `[1,0,0]`, zero, or wrong-dimension batch fails loudly and preserves existing real vectors.
### `memory provider rebless-embeddings --baseline-root <path> [--plan|--apply]`
Update stale embedding hashes for proven redaction-only rewrites without calling the embedding provider. The baseline root must contain the pre-redaction markdown bytes for the same vault; the command only reblesses a record when the stored hash matches the baseline embedding text and the baseline/current embedding text are identical after secret redaction and truncation. Use `--plan` first; `--apply` rewrites only matching sidecar hashes and refuses wrong-dimension or degenerate vectors.
### `memory provider audit-summary [--days <n>]`
Summarize LLM audit-log calls over a window: per-consumer counts, cost (or `unknown`), references stripped, prose-path leaks.
### `memory provider audit-rotate [--plan|--apply] [--keep-days <n>]`
Archive `.audit/` logs older than the keep window (default 30 days) under `wiki/.audit/archive/` (archive-by-default; no hard delete without `--apply`).

---

## Git sync

### `memory sync [--remote-name <n>] [--branch <b>]`
Pull-rebase then push to the configured vault remote; surfaces conflicts loudly (records `conflict_files` in `.sync-state.json`). Use `--remote-name` or `sync.remote_name` when the remote is not the legacy `vps` name, for example a Whitedragon remote.
### `memory pull` / `memory push`
Pull-rebase only / push-with-retry only.

---

## Maintenance & migration

### `memory prune [--plan|--apply] [--restore <path>]`
Plan/archive raw observations past `retention.raw_window_days` (config-driven; archive-first, never hard-delete). `--restore` brings an archived file back.
### `memory decay [--plan|--apply]`
Decay narrative record `strength` by `0.9` per 14-day period since `last_accessed`. Pages below strength `1.0` with no access for at least 180 days move to `wiki/.archive/<date>/`; `pinned: true` pages are skipped.
### `memory migrate-to-narrative [--plan|--apply]`
Plan or apply conversion of existing knowledge pages with headings, lists, checklists, code fences, or tables into narrative records. Apply mode archives the prior page, increments `version`, and stages unsafe rewrites in `wiki/compile-proposed/`.
### `memory backfill [--from <client>] [--since <date>] [--plan|--apply] [--consolidate-after]`
Import historical sessions from a local client store into `raw/`.
### `memory backfill-source [--plan|--apply] [--force]`
Add missing `source:` frontmatter to live wiki pages.
### `memory rewrite-imported-timestamps`
Add `observed_at` dates to imported agentmemory files from their UUIDv7 ids.
### `memory import-agentmemory [--from <path>] [--plan|--apply] [--consolidate-after]`
One-shot migration from the legacy agentmemory store. (`import-from-agentmemory` is a deprecated alias.)
### `memory watch [--clients <list>]`
Run live capture watchers for supported local clients.
### `memory tail-errors`
Live-tail `~/.memory/errors.log`.

---

## Diagnostics

### `memory eval-retrieval [--corpus <path>] [--gold <path>] [--k <csv>] [--limit <n>] [--json]`
Run the checked-in retrieval gold set against local search twice: with graph spreading enabled and disabled. Reports Recall@K, MRR, graph lift, and per-type breakdowns for fact, causal, temporal, dependency, and provenance questions. Defaults are `--corpus ~/.memory`, `--gold qa/retrieval-gold.jsonl`, and `--k 5,10`. The command exits non-zero and prints a loud warning when graph lift@5 is not positive.

### `memory stats`
File counts, install status, git state.
### `memory doctor`
Structural health check; non-zero exit if any check fails.
### `memory verify [--role operator|server] [--offline] [--dashboard-url <url>] [--remote-name <name>] [--json] [--schedule install|uninstall|status] [--daily HH:MM] [--shell powershell|systemd]`
End-to-end health: vault, sync, dashboard, search, client capture. `operator` adds client-capture checks; `server` is vault/sync/search/dashboard only. Use `--dashboard-url` or `dashboard.url` for hosted dashboard checks, and `--remote-name` or `sync.remote_name` when the vault sync remote is not named `vps`. Notable checks: `vault.read-write`, `search.pipeline`, `graph.cohesion`, `retrieval.embedding-health`, `frontmatter.source`, `storage.atomic-write-retries`, `sync.uncommitted-vault`, `compile.recent`, `compile.execute-health`, `config.valid`, `retrieval.intent-classifier-health`. `retrieval.embedding-health` warns when sidecars are absent and fails on stub, identical, zero, or wrong-dimension vectors. `--schedule` installs/removes a daily verify task.

---

## Stubs (registered, not yet implemented — exit 2)

`crystallize`, `backup`, `retain`, `schedule` print a "not yet implemented" message. (VPS backups are handled by the deployed `memory-backup.timer`, not the CLI `backup` stub.)

---

## Environment variables

- `MEMORY_ROOT` — override the vault location (default `~/.memory`).
- `VOYAGE_API_KEY` / `OPENAI_API_KEY` — embedder keys (env-only, never in config.yaml).
- `OPENROUTER_API_KEY` — LLM key (env-only).
- `OLLAMA_HOST` — local Ollama endpoint.
- `MEMORY_LLM_DISABLED=true` — kill switch for all LLM features.
- `MEMORY_LLM_DEBUG_LOG=1` — persist plaintext prompts/responses to `wiki/.audit/llm-debug-*.md` (default off; the only path to plaintext LLM logs).
