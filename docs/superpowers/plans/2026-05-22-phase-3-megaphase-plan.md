# Phase 3 Megaphase — Sync, Dashboard, Retrieval, MCP Search

**Supersedes:** `docs/superpowers/plans/2026-05-22-phase-3-retrieval-plan.md` at commit `2095737`.
**Phase 2 tag:** `v0.2.0-phase2` (commit `4276753`).
**Date:** 2026-05-22.
**Scope:** Multi-machine sync via the user's VPS, Tailscale-only web dashboard, full hybrid retrieval signals, CLI/MCP search, and deployment/operations around the same `~/.memory/` vault model.

This is a megaphase. The old Phase 3 plan treated retrieval as a single-machine CLI/MCP feature. The clarified target is a personal memory platform: local tools keep writing local `~/.memory/`, the VPS becomes the sync and dashboard hub, and every agent surface can query the same retrieval backend.

---

## Goals

- Keep `~/.memory/` as the source-of-truth vault format: markdown + YAML frontmatter + JSONL embedding sidecars + git history.
- Add multi-machine sync through a private bare git repository on the VPS, with local checkouts on Windows machines and a dashboard checkout on the VPS.
- Add `memory sync` / `memory pull` / `memory push` workflows that are explicit, conflict-aware, and safe for multiple machines.
- Deploy a Tailscale-only web dashboard on the VPS for reading/searching memory, viewing graph relations, inspecting raw/compile history, and checking sync health.
- Implement `memory search "<query>"` and MCP `memory.search` over all retrieval signals: exact/BM25, embeddings, graph expansion, metadata/recency/status signals, HyDE, RRF, and rerank.
- Persist embeddings in JSONL sidecars only. No vector database.
- Use the same retrieval backend from CLI, MCP, and dashboard.
- Keep all network exposure private to the tailnet. No public dashboard route.

## Acceptance criteria

- A fresh VPS install creates `/root/memory-system/` with a bare repo, dashboard checkout, service config, logs, and backup hooks.
- Windows `C:\Users\Admin\.memory` can add the VPS as a remote, push to it, pull from it, and recover from a normal non-conflicting sync.
- The VPS dashboard reads the synced memory checkout and is reachable only over Tailscale at `https://srv1317946.tail6916d8.ts.net/memory/` or another explicitly documented Tailscale-only route.
- `memory search "agentmemory codex stability"` returns ranked raw/wiki results from the dogfooded corpus.
- `memory.search` MCP tool returns the same result set as `memory search --json` for the same query/options.
- Dashboard search returns the same backend results as CLI/MCP.
- Embeddings sidecars persist between searches; unchanged content hashes skip re-embedding.
- If Voyage is unavailable, CLI/MCP/dashboard degrade to BM25 + graph + metadata with a visible warning.
- systemd services/timers for dashboard and VPS sync jobs are installed and restart cleanly.
- Phase 1 + Phase 2 tests keep passing throughout. Each implementation slice adds focused tests before behavior changes.

## Out of scope

- Public internet dashboard access.
- Team/multi-user authorization. Tailnet membership is the access boundary for Phase 3.
- Multi-tenant memory hosting.
- Vector databases: Pinecone, Qdrant, Chroma, lancedb, sqlite-vec, and similar are rejected for Phase 3.
- Live collaborative editing in the dashboard. The dashboard can be read-mostly; edits remain CLI/agent/Obsidian/git-mediated unless explicitly scoped later.
- Replacing Obsidian. The dashboard complements the vault; Obsidian remains a first-class local GUI.
- Retention automation beyond what search/sync needs. Phase 6 still owns retention policy.

## VPS environment (verified 2026-05-22)

Discovery target: local `tailscale status` showed one active Linux host, `srv1317946`, and `tailscale ping srv1317946` returned `pong from srv1317946 (100.85.80.22)`.

### Identity and MagicDNS

```text
tailscale ip -4 srv1317946
100.85.80.22

Resolve-DnsName srv1317946.tail6916d8.ts.net
srv1317946.tail6916d8.ts.net. A 100.85.80.22
```

On the VPS:

```text
hostname
srv1317946

whoami
root

tailscale status --self
100.85.80.22     srv1317946         a.o.alkulaib@  linux    -
```

From `tailscale status --json` on the VPS:

```json
{
  "TailscaleIPs": ["100.85.80.22", "fd7a:115c:a1e0::f501:508e"],
  "Self": {
    "HostName": "srv1317946",
    "DNSName": "srv1317946.tail6916d8.ts.net.",
    "OS": "linux"
  },
  "MagicDNSSuffix": "tail6916d8.ts.net",
  "CurrentTailnet": {
    "Name": "a.o.alkulaib@gmail.com",
    "MagicDNSSuffix": "tail6916d8.ts.net",
    "MagicDNSEnabled": true
  },
  "CertDomains": ["srv1317946.tail6916d8.ts.net"]
}
```

Tailscale Serve is already in use:

```text
https://srv1317946.tail6916d8.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:18789

https://srv1317946.tail6916d8.ts.net:8443 (tailnet only)
|-- / proxy http://127.0.0.1:5678
```

Planning implication: do not break the existing root route. Use `https://srv1317946.tail6916d8.ts.net/memory/` as the planned dashboard route unless the user later chooses to move the existing root service.

### OS, runtime, git, systemd

```text
PRETTY_NAME="Ubuntu 25.10"
NAME="Ubuntu"
VERSION_ID="25.10"
VERSION="25.10 (Questing Quokka)"
VERSION_CODENAME=questing
ID=ubuntu
ID_LIKE=debian
```

```text
node --version
v22.22.0

git --version
git version 2.51.0

systemctl --version
systemd 257 (257.9-0ubuntu2.4)
```

Planning implication: no Node bootstrap is needed on the VPS. systemd is available for services/timers.

### Disk

```text
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       193G  119G   74G  62% /
/dev/sda13      989M  186M  737M  21% /boot
/dev/sda15      105M  6.3M   99M   6% /boot/efi
```

Planning implication: use `/root/memory-system/` (`~/memory-system/` for the SSH user) as the default install root. It lives on `/`, which has 74G free.

### Listening ports and conflicts

```text
100.85.80.22:443    tailscaled
100.85.80.22:8443   tailscaled
127.0.0.1:8222      docker-proxy
76.13.32.137:443    caddy
127.0.0.1:2019      caddy
76.13.32.137:80     caddy
127.0.0.1:18789     openclaw
127.0.0.1:18790     python3
127.0.0.1:4000      litellm
127.0.0.1:5050      docker-proxy
0.0.0.0:18791       node
127.0.0.1:4400      node
127.0.0.1:5678      node
127.0.0.1:5679      node
127.0.0.1:5432      postgres
0.0.0.0:22          sshd
0.0.0.0:8900        python3/clawmetry
0.0.0.0:9119        hermes
127.0.0.1:6333      docker-proxy
127.0.0.1:6379      redis-server
127.0.0.1:16379     docker-proxy
100.85.80.22:8088   caddy
127.0.0.1:15432     docker-proxy
*:3101              node
```

Planning implication: avoid ports 3000-3999 because `*:3101` is occupied and the user asked to inspect that range. Choose a dashboard app port outside the busy range, e.g. `127.0.0.1:4410`, and publish through Tailscale Serve path routing.

### Reverse proxy and Vaultwarden

```text
which nginx
not-found

which caddy
/usr/bin/caddy

which traefik
not-found

caddy.service
Active: active (running) since Mon 2026-05-04 15:04:34 UTC
```

Vaultwarden signal:

```text
docker ps
vaultwarden    vaultwarden/server:latest    127.0.0.1:8222->80/tcp
```

Caddyfile lines:

```text
/etc/caddy/Caddyfile:48:# BEGIN vaultwarden
/etc/caddy/Caddyfile:49:vault.alkulaib.io {
/etc/caddy/Caddyfile:52:    reverse_proxy 127.0.0.1:8222
/etc/caddy/Caddyfile:54:# END vaultwarden
```

Planning implication: public Caddy already owns `vault.alkulaib.io` for Vaultwarden. The memory dashboard should not be public Caddy by default; use Tailscale Serve for tailnet-only access. If Caddy is used internally, bind it to loopback only.

### Backup signals

Root crontab includes:

```text
# Daily OpenClaw backup at 3:00 AM UTC
0 3 * * * /root/.openclaw/backup.sh >> /root/.openclaw/backup.log 2>&1
0 3 * * * /opt/vaultwarden/backup.sh >> /var/log/vaultwarden-backup.log 2>&1
```

Vaultwarden backup script:

```text
BACKUP_DIR="/opt/vaultwarden/backups"
DATA_DIR="/opt/vaultwarden/data"
sqlite3 "${DATA_DIR}/db.sqlite3" ".backup ${TMP_DB}"
tar -czf "$ARCHIVE" "$TMP_DB" "${DATA_DIR}/config.json" "${DATA_DIR}/rsa_key"* "${DATA_DIR}/attachments" 2>/dev/null || true
ls -t "${BACKUP_DIR}/vaultwarden_"*.tar.gz 2>/dev/null | tail -n +31 | xargs -r rm -f
```

Planning implication: add `/root/memory-system/backup.sh` and a daily root crontab or systemd timer at a non-conflicting time. The backup should archive the bare repo, dashboard checkout metadata, and service config. It should not mix into Vaultwarden's archive, but should follow the same local-archive + rotation pattern.

## VPS re-verified (2026-05-22 post-upgrade)

The user upgraded the VPS after the initial discovery — Ubuntu major version bump, new Docker workloads, new host services. Re-verified via direct SSH from WhiteDragon. Memory-system install survived intact; Phase 3 design assumptions still hold. No plan changes required.

| Item | 2026-05-22 baseline | Post-upgrade | Impact |
|---|---|---|---|
| Hostname | srv1317946 | srv1317946 | none |
| OS | Ubuntu 25.10 | **Ubuntu 26.04 LTS** (Resolute Raccoon) | none |
| systemd | 257 | 259 | none |
| git | 2.51.0 | 2.53.0 | none |
| Node | v22.22.0 | v22.22.0 | none |
| Disk | 74G free on / | 193G total, 72G free, 122G used | none |
| Caddy | active, fronts vault.alkulaib.io | active v2.11.3, also bound on 100.85.80.22:8088 (new tailnet-IP listener) | none for memory dashboard plan |
| Tailscale Serve routes | root → 127.0.0.1:18789, :8443 → 127.0.0.1:5678 | unchanged | `/memory/` subpath strategy unaffected |
| Vaultwarden | Docker, healthy | Docker, healthy (uptime varies — periodic Docker restarts observed during slice smokes) | none |
| memory-system install | Slice 1+2 deployed | Intact: install-info.json, post-receive hook, last checkout `9d1a721` (Slice 3 cleanup) | all artifacts survived |
| Port 4410 (planned dashboard) | reserved, free | still free | dashboard plan unaffected |

### New services on the box

Services added since the baseline discovery. None conflict with memory-system Phase 3:
- **iAqar stack**: `iaqar-postgres` (port 15432 → container 5432) + `iaqar-redis` (port 16379 → container 6379) + Fastify API at port 4400 (`/opt/iaqar/current/apps/api/dist/index.js`). User's Riyadh investment analyzer now hosted on the same VPS.
- **alkulaib-staging**: Docker container `alkulaib:86708fd3...` on port 5050. Staging environment for alkulaib.io.
- **next-server v16.1.6**: Next.js 16 app on port 3000. Likely the public alkulaib.io site or related.
- **qdrant-openclaw**: Qdrant vector DB container on port 6333 — used by OpenClaw, NOT by memory-system. The "no vector DB" decision in §Boundaries still applies to memory-system; Qdrant's presence on the box is unrelated.
- **Redis on host**: port 6379 (separate from the iaqar-redis container at 16379). Likely used by OpenClaw or alkulaib-staging.
- **Postgres on host**: port 5432 (separate from iaqar-postgres). Likely used by OpenClaw or alkulaib-staging.

The Caddyfile likely added iAqar + alkulaib-staging routing during the upgrade. Direct inspection deferred — none of these public-facing routes affect memory-system, which uses Tailscale Serve, not public Caddy.

### Confirmation

Phase 3 slices 3.5 (auto-sync) and forward proceed unchanged. The architectural assumptions in §Architecture and the slice ports/paths in the slices below remain valid post-upgrade. Future slices that touch VPS infrastructure (4, 5, 6, 14, 19, 21) should still snapshot service state pre/post per the implementer notes.

## Architecture

Phase 3 has four layers:

1. **Local vaults:** each machine keeps a real `~/.memory/` git repo. Hooks, MCP, compile, lint, page, and Obsidian keep working offline.
2. **VPS sync hub:** `/root/memory-system/memory.git` is the private bare remote. Pushes update `/root/memory-system/vault/`, a working checkout used by the dashboard and retrieval service.
3. **Retrieval backend:** shared TypeScript modules load corpus snapshots, refresh embeddings, score BM25/vector/graph/metadata signals, fuse with RRF, optionally run HyDE and rerank, and return structured results.
4. **Surfaces:** CLI (`memory search`, `memory sync`), MCP (`memory.search`), and dashboard (Tailscale-only web UI) all call the same backend.

Data flow:

```text
Windows ~/.memory/  --git push/pull-->  VPS /root/memory-system/memory.git
                                            |
                                            v
                                     /root/memory-system/vault
                                            |
                +---------------------------+---------------------------+
                |                           |                           |
          dashboard UI                retrieval backend            backup job
       Tailscale /memory/          BM25 + vectors + graph         local tarballs
```

## Step-by-step slices

### Slice 1 — VPS sync layout and install script

- Goal: create an installer that lays out `/root/memory-system/` on the VPS: `memory.git` bare repo, `vault/` checkout, `backups/`, `logs/`, `services/`, and `env/`.
- Files: `src/cli/commands/install-vps.ts` (new), `src/cli.ts`, `test/cli/commands/install-vps.test.ts`, docs for the command.
- Acceptance: dry-run mode prints the exact directories and commands; real smoke on `srv1317946` creates the layout without touching existing services.
- Notes: this slice may use SSH in a smoke test but unit tests mock command execution. Default install root is `/root/memory-system`.

### Slice 2 — Git remote bootstrap and post-receive checkout

- Goal: add a local command that configures `~/.memory` to use the VPS bare repo as remote and a VPS-side `post-receive` hook that checks out to `/root/memory-system/vault`.
- Files: `src/cli/commands/sync-bootstrap.ts` (new), `src/sync/git-remote.ts` (new), tests.
- Acceptance: temp repos prove a push to bare updates a working checkout; existing local commits are preserved; remote name defaults to `vps`.
- Notes: checkout must be atomic enough for dashboard reads: write to a staging tree or use a lock file during checkout.

### Slice 3 — `memory sync`, `memory pull`, `memory push`

- Goal: implement explicit sync commands with conflict detection and clear output. `memory sync` runs commit-if-needed (optional flag), pull --rebase, push.
- Files: `src/cli/commands/sync.ts` (new), `src/sync/status.ts` (new), `src/cli.ts`, tests.
- Acceptance: tests cover clean sync, local-ahead, remote-ahead, divergent conflict, and dirty worktree requiring user action.
- Notes: do not auto-resolve markdown conflicts. The user or active agent handles conflicts.
- Notes: `memory sync` runs `git pull --rebase` followed by `git push`. On push-reject (remote-ahead), retry pull-rebase + push once more.
- Notes: real merge conflicts after rebase are surfaced loudly: write to `errors.log`, increment `conflicts-pending` in `~/.memory/.sync-state.json`, and exit non-zero from the CLI.
- Notes: conflicts are never auto-resolved.

### Slice 3.5 — Auto-sync post-hook

- Goal: trigger `git push` automatically after each hook batch on creator machines. Debounce ~5 seconds so a burst of writes coalesces into one push. Async — never blocks the hook itself. Failures (offline, VPS down) log as info, not error.
- Files: `src/sync/auto-push.ts` (new), updates to `src/hooks/util/` to call into the auto-push debouncer from PostToolUse/Stop/SessionEnd handlers, `test/sync/auto-push.test.ts` (new).
- Acceptance: unit tests cover debounce coalescing, success path, push-reject (triggers pull-rebase + retry), and offline path (logs as info, increments pending-push counter, does not crash). Real smoke from WhiteDragon pushes to the VPS bare repo within 5 seconds of a hook write.
- Notes: auto-sync uses the same `memory sync` machinery from Slice 3; this slice is the trigger, not the implementation of push-retry-pull-rebase.

### Slice 3.6 — `merge-conflict` lint category

- Goal: extend Phase 2 `memory lint --checks-only` with a blocking `merge-conflict` category.
- Files: `src/curation/checks.ts` (modify existing), `test/curation/checks.test.ts` (extend existing).
- Acceptance: scanner checks every `.md` file under `~/.memory/wiki/`, `~/.memory/raw/`, and `~/.memory/crystals/` for `<<<<<<<`, `=======`, and `>>>>>>>` on lines of their own. Each hit is reported as a `merge-conflict` issue. `memory lint --checks-only` exits 1 when any `merge-conflict` issue exists.
- Notes: this category joins `frontmatter` and `broken-relation` as a data-integrity blocker.

### Slice 3.7 — Sync status surfaces and compile runner guard

- Goal: surface sync health in Phase 1 commands and reduce accidental multi-machine compile conflicts.
- Files: `src/cli/commands/stats.ts`, `src/cli/commands/doctor.ts`, `src/cli/commands/compile.ts`, sync-state helpers, tests.
- Acceptance: `memory stats` and `memory doctor` show last-synced timestamp, pending-push count, and conflict-pending count from `~/.memory/.sync-state.json`. `memory compile` reads `roles.compile_runner` from `~/.memory/config.yaml`.
- Notes: new config key: `roles.compile_runner: <machine-hostname>` (default empty — no preferred runner).
- Notes: if `compile_runner` is set and current hostname does not match, `memory compile` prints `This machine isn't the designated compile runner (configured: <name>; this machine: <hostname>). Running compile here may produce merge conflicts. Press Enter to proceed, Ctrl-C to abort.` to stderr and waits for confirmation.
- Notes: enforcement is soft. `--force` skips the prompt; it never hard-blocks.

### Slice 4 — VPS systemd services and timers

- Goal: install `memory-dashboard.service`, `memory-dashboard-checkout.path` or timer, and `memory-backup.timer` on the VPS.
- Files: `templates/systemd/*.service` (new), `templates/systemd/*.timer` (new), installer updates, tests that render units.
- Acceptance: `systemctl status memory-dashboard` is active after smoke; `systemctl list-timers` shows memory backup timer.
- Notes: use `WorkingDirectory=/root/memory-system/app` or equivalent; bind app to `127.0.0.1:4410`.

### Slice 5 — Tailscale-only dashboard route

- Goal: expose the dashboard at `https://srv1317946.tail6916d8.ts.net/memory/` without disturbing existing root and `:8443` Tailscale Serve routes.
- Files: VPS install command and docs. Possibly no source if command emits exact manual `tailscale serve` instructions.
- Acceptance: `tailscale serve status` shows `/memory/ proxy http://127.0.0.1:4410`; local browser can open the route from the tailnet.
- Notes: if Tailscale Serve path routing conflicts with the existing root route, stop and ask before reconfiguring root.

### Slice 6 — Dashboard skeleton

- Goal: create a minimal Node web app served from the VPS that reads the synced vault and renders status: repo commit, raw count, wiki count, last compile, errors.log state.
- Files: `src/dashboard/server.ts` (new), `src/dashboard/render.ts` (new), `test/dashboard/*.test.ts`, build config if needed.
- Acceptance: dashboard smoke returns HTML with counts from `/root/memory-system/vault`.
- Notes: no new frontend framework unless the current toolchain demands it. Keep it server-rendered HTML for Phase 3 unless the user later asks for richer UI.

### Slice 7 — Dashboard browse/read pages

- Goal: add dashboard views for wiki index, page detail, relations, inbound references, raw sessions, and log tail.
- Files: dashboard modules and tests.
- Acceptance: clicking a page shows the same content as `memory page`, including relations and inbound references.
- Notes: reuse `runPage` or a shared renderer to avoid divergent behavior.

### Slice 8 — Corpus loader across raw/wiki/crystals

- Goal: create `SearchDocument[]` snapshots for `raw`, `wiki`, `crystals`, or `both/all`. Include title, type, status, confidence, tags, relations, source, session, mtime, and text.
- Files: `src/retrieval/corpus.ts`, tests.
- Acceptance: temp corpus with raw, wiki, and crystal docs loads deterministically and with forward-slash relative paths.
- Notes: this is the shared input for all retrieval signals and dashboard browse.

### Slice 9 — BM25 + exact lexical retrieval

- Goal: implement in-process tokenizer and BM25 with `k1=1.2`, `b=0.75`, plus exact filename/title/tag boosts.
- Files: `src/retrieval/bm25.ts`, `src/retrieval/exact.ts`, tests.
- Acceptance: exact title/file/tag hits beat body-only hits; no external dependency.

### Slice 10 — Embedding sidecars and lazy refresh

- Goal: implement `wiki.embeddings.jsonl`, `raw.embeddings.jsonl`, `crystal.embeddings.jsonl`, and `embeddings.meta.json` with SHA256 model/dim checks.
- Files: `src/retrieval/embeddings-store.ts`, `src/retrieval/refresh.ts`, tests.
- Acceptance: first search embeds changed docs; second search embeds zero unchanged docs; stale paths are pruned.
- Notes: use official `voyageai` package pinned to `~0.2.1` unless Slice 10 web-check finds a newer 0.2 patch.

### Slice 11 — Voyage client + fallback

- Goal: wrap Voyage embeddings and rerank. Read `VOYAGE_API_KEY` from env with optional `config.yaml` override. Normalize errors to warnings.
- Files: `src/retrieval/voyage-client.ts`, `src/storage/config.ts`, tests.
- Acceptance: mocked unit tests cover env/config precedence and errors; real smoke returns a 2048-dim `voyage-4-large` vector.
- Notes: every `voyageClient.embed()` and `voyageClient.rerank()` call wraps in a 30-second hard timeout using `AbortController` or the SDK's equivalent cancellation API.
- Notes: timeout rejects as `VoyageTimeoutError`, extending `VoyageUnavailableError`.
- Notes: search degrades through the same fallback path as "Voyage unreachable."

### Slice 12 — Graph signal and metadata signal

- Goal: parse relations and wikilinks into an in-memory graph; compute one-hop expansion; add metadata/recency/status/confidence boosts.
- Files: `src/retrieval/graph.ts`, `src/retrieval/metadata-score.ts`, tests.
- Acceptance: graph expansion adds linked pages; archived pages are de-prioritized; recent active pages receive a small deterministic boost.
- Notes: metadata is a signal, not a replacement for lexical/semantic scores.

### Slice 13 — RRF fusion and rerank

- Goal: combine exact, BM25, vector, graph, and metadata ranked lists with RRF, then optionally rerank the top candidates with Voyage Rerank 2.5.
- Files: `src/retrieval/rrf.ts`, `src/retrieval/rerank.ts`, tests.
- Acceptance: known ranked lists fuse to expected order; rerank can reorder top candidates; `--no-rerank` skips the call.

### Slice 14 — HyDE orchestration

- Goal: add `prompts/hyde.md` and a CLI/MCP/dashboard flow where the in-session LLM can supply expanded text. The system never calls an LLM directly for HyDE.
- Files: `templates/prompts/hyde.md`, init copy updates, `src/retrieval/hyde.ts`, CLI/MCP/dashboard wiring.
- Acceptance: short/abstract query emits HyDE prompt unless disabled; supplied expansion reaches embedding input.

### Slice 15 — Search core backend

- Goal: `runSearch(query, opts)` ties all signals together and returns `{ results, warnings, timings, degraded }`.
- Files: `src/retrieval/search.ts`, tests.
- Acceptance: CLI, MCP, and dashboard can call the same function; degraded mode returns lexical results; results include source contribution metadata.

### Slice 16 — `memory search` CLI

- Goal: replace the search stub with real CLI search: `--scope raw|wiki|crystals|all`, `--k`, `--min-score`, `--no-rerank`, `--no-hyde`, `--json`, `--explain`.
- Files: `src/cli/commands/search.ts`, `src/cli.ts`, `test/cli/commands/search.test.ts`, `test/cli/stubs.test.ts`.
- Acceptance: JSON output parses; pretty output is readable; fallback warning goes to stderr.
- Notes: when the VPS API is unreachable (timeout > 5 seconds or network error), print this exact text to stderr and exit 3:

```text
Search backend offline (VPS unreachable). To find content while offline:

Use memory.list_pages to browse the wiki structure
Use memory.read_page to fetch a specific page
Run "memory grep <keywords>" in a shell for keyword search
```

- Notes: exit 3 is distinct from invalid flags (2) and internal errors (1).

### Slice 17 — MCP `memory.search`

- Goal: add MCP search tool over the same backend.
- Files: `src/mcp/server.ts`, `test/mcp/server.test.ts`.
- Acceptance: existing MCP tools still pass; real Claude Code MCP call returns ranked results from the synced corpus.
- Notes: when the VPS API is unreachable (timeout > 5 seconds or network error), return this exact text as the tool error response so Claude can fall back to existing tools:

```text
Search backend offline (VPS unreachable). To find content while offline:

Use memory.list_pages to browse the wiki structure
Use memory.read_page to fetch a specific page
Run "memory grep <keywords>" in a shell for keyword search
```

### Slice 18 — Dashboard search and graph views

- Goal: add dashboard search UI, result explanation, graph neighborhood, and sync status pages.
- Files: dashboard modules and tests.
- Acceptance: dashboard search result count and ordering match `memory search --json` for the same query/options.
- Notes: graph view can start as HTML lists/tables; no heavy client graph library unless later scoped.
- Notes: top of dashboard always shows either `Last synced: <timestamp>` or `X commits pending push (offline since <timestamp>)`.
- Notes: if `conflicts-pending > 0` from `~/.memory/.sync-state.json` or the `merge-conflict` lint category finds any issue, display a red banner: `X files have unresolved merge conflicts` with a list of paths.
- Notes: banner links open the conflicted file path in the dashboard for read-only reference. The user resolves via their editor.

### Slice 19 — Backup and restore

- Goal: add VPS backup script/timer for `/root/memory-system/`: bare repo, service config, dashboard env, and logs. Add restore docs.
- Files: `templates/scripts/memory-backup.sh`, systemd timer, docs.
- Acceptance: smoke creates a tarball in `/root/memory-system/backups`, rotates old backups, and restore test can clone the bare repo from an archive.
- Notes: follow Vaultwarden's local tarball + rotate-last-30 pattern, but keep memory backups separate.

### Slice 20 — Docs

- Goal: document sync, dashboard, search, VPS install, Tailscale-only access, backup/restore, and troubleshooting.
- Files: `docs/cli.md`, `docs/architecture.md`, `docs/retrieval-workflow.md`, `docs/sync-workflow.md`, `docs/dashboard.md`, `docs/sync-conflict-runbook.md` (new).
- Acceptance: user can install on a new machine and connect to the VPS without rereading this plan.
- Notes: `docs/sync-conflict-runbook.md` walks the user through spotting conflicts (lint output, dashboard banner, stats), reading git conflict markers, choosing a resolution, committing the resolved file, and resuming sync.
- Notes: `docs/retrieval-workflow.md` includes search-latency expectations: first search after a large curation pass may take 5-15 seconds while embeddings refresh; subsequent searches are fast.

### Slice 21 — Megaphase checkpoint

- Goal: dogfood end-to-end: Windows local memory pushes to VPS, dashboard shows current curation pass, search works from CLI/MCP/dashboard, Voyage real call works, fallback works with key removed, backup tarball exists.
- Files: checkpoint memo only.
- Acceptance: memo records exact commands, URLs, latencies, sidecar sizes, service statuses, and any blocking issues.

### Slice 22 — Tag `v0.3.0-phase3`

- Goal: annotated tag after sync, dashboard, retrieval, MCP, docs, and checkpoint are green.
- Files: none.
- Acceptance: `git describe --tags` returns `v0.3.0-phase3`; tag message mentions sync hub, Tailscale dashboard, all retrieval signals, and checkpoint status.

## Boundaries

- Tailscale-only dashboard. Do not expose memory dashboard through public Caddy or a public DNS name.
- No vector database.
- No real Voyage calls in unit tests.
- No silent fallback. Degraded retrieval must be visible.
- No automatic conflict resolution for git sync.
- Do not mutate `~/.memory/` during planning or tests except in explicit temp fixtures or scoped implementation smoke tests.
- Existing Vaultwarden, OpenClaw, Litellm, Caddy, and Tailscale routes must not be broken.
- Keep `raw/`, `wiki/`, `crystals/`, and `embeddings/` as plain files. The dashboard reads the vault; it does not become the storage layer.

## Risks

- **Existing Tailscale Serve root is occupied.** Mitigation: use `/memory/` path route or ask before moving root.
- **Git conflicts across machines.** Mitigation: explicit sync commands, clear conflict output, no auto-resolution.
- **VPS already has several services and occupied ports.** Mitigation: bind dashboard to `127.0.0.1:4410`; publish through Tailscale path route.
- **Voyage outage/quota.** Mitigation: BM25 + graph + metadata fallback.
- **Dashboard accidentally public.** Mitigation: Tailscale Serve only; if Caddy is used internally, bind loopback.
- **Backups miss the bare repo.** Mitigation: backup the bare repo and checkout metadata explicitly; checkpoint restore test.
- **Megaphase too large.** Mitigation: each slice is independently testable and committable; checkpoint gates before tag.

## Resolved before Slice 1 (2026-05-22 grill round)

- Dashboard route: use `/memory/` under `https://srv1317946.tail6916d8.ts.net/`; do not move the existing root route.
- VPS storage root: use `/root/memory-system/` for the bare repo, checkout, service config, logs, and backups.
- Raw embeddings: enabled by default, alongside wiki and crystal embeddings.
- Dashboard mutability: read-only for Phase 3. Users resolve edits/conflicts through their editor, agent, Obsidian, or CLI.
- Backup strategy: local rotating tarball backups on the VPS for Phase 3; no off-box backup requirement in this phase.
- Auto-sync: creator machines auto-push after hook batches with ~5s debounce. Offline/VPS-down states are info, not errors.
- Conflict policy: pull-rebase + push retry once; real conflicts are never auto-resolved and are surfaced in `errors.log`, `.sync-state.json`, lint, stats, doctor, and dashboard.
- Offline search behavior: CLI exits 3 and MCP returns a tool error with the exact fallback instructions when the VPS API is unreachable for more than 5 seconds or errors at the network layer.
- Refresh latency: first search after a large curation pass may take 5-15 seconds while embeddings refresh; subsequent searches should be fast because content hashes skip unchanged documents.

## Notes for implementers

Use the strict Phase 2 prompt style: exact pre-flight commit/tag, exact scope guard, exact tests, red phase for behavior changes, focused tests before full suite, manual smoke for real services, and honest deviations.

Any slice that touches the VPS must start by recording current `tailscale serve status`, `ss -tlnp`, and `systemctl status caddy` so changes do not trample existing services.

Any slice that touches sync must test on temp repos before touching real `C:\Users\Admin\.memory` or `/root/memory-system`.

Any slice that touches dashboard routing must be reversible and must not remove existing Tailscale Serve root or `:8443` routes without explicit user approval.
