---
schema_version: 1.1
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
- **Antigravity desktop** (via MCP only — Antigravity has no hook system)

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
| `references` | `wiki/references/` | `<short-slug>.md` | External knowledge: papers, blog posts, docs, talks |
| `tools` | `wiki/tools/` | `<package-or-binary-name>.md` | A software dependency or service used by a project |
| `crystal` | `crystals/` | `<YYYY-MM-DD>-<thread-slug>.md` | A long-form distillation of a completed work thread (Wiki v2 addition) |

Raw session files (`raw/<date>/<tool>-<session-id>.md`) carry `type: raw-session` and are not part of the wiki proper — they're the source observations the compile workflow distills into wiki pages.

---

## 3. Frontmatter contract

Every wiki page (and every raw session file) begins with YAML frontmatter:

```yaml
---
type: projects | people | decisions | lessons | references | tools | crystal | raw-session
title: "Human-readable title"
created: 2026-05-21    # ISO 8601 date
updated: 2026-05-21
status: active | archived | superseded   # optional; defaults to active
confidence: 0.0..1.0    # optional; default 1.0; pages with < 0.5 surface as DRAFT in lint
source: claude-code | codex | antigravity | manual | crystal   # who created this
session: <id>            # optional; the session that produced this page
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

**Required body element:** the first line after frontmatter is a one-sentence summary of the page. This is what shows in `index.md` and search snippets. Lead with the summary; expand below.

Cross-references inside the body use Obsidian-style `[[wiki/projects/agentmemory]]` or shorthand `[[agentmemory]]` when the slug is unambiguous.

---

## 4. Naming rules

- All filenames are **lowercase kebab-case**: `lisan-studio.md`, not `LisanStudio.md` or `lisan_studio.md`.
- Date prefixes use **ISO 8601** (`YYYY-MM-DD`), zero-padded.
- Slugs are short and grep-friendly — favor `windows-stale-ports` over `the-time-windows-held-stale-listening-sockets-on-3111`.
- For decision pages, the date is the date the *decision was made*, not the date the page was written.
- For lesson pages, no date prefix — lessons are timeless.
- Person pages: first name only unless there's a collision; use `-lastname` only to disambiguate.

---

## 5. Edge types (knowledge graph)

The graph is derived on-demand from `relations:` frontmatter (and inline `[[wikilinks]]` which create implicit `linked` edges). Nine canonical edge types are supported; use them precisely.

| Type | Direction | Semantics | Example |
|---|---|---|---|
| `uses` | A → B | A is a project that uses B (a tool/library) | `agentmemory` uses `typescript` |
| `depends_on` | A → B | A's functioning requires B | `lisan-studio` depends_on `qt6` |
| `supersedes` | A → B | A replaces B; B is archived | `lisan-studio` supersedes `vs-code-arabic` |
| `contradicts` | A → B | A's content disagrees with B; needs human resolution | `2026-05-21-restore-onedrive-data` contradicts an earlier decision page |
| `caused_by` | A → B | A (a problem or event) was caused by B | `stale-listening-sockets` caused_by `iii-config-port-hardcoding` |
| `fixed_by` | A → B | A was fixed by B (a decision, commit, or lesson) | `dead-pid-survivor-guard` fixed_by `2026-05-20-decide-stop-action-filter` |
| `derived_from` | A → B | A's content was distilled from B (typical: crystal from raw thread) | `2026-05-20-agentmemory-stabilization` derived_from `raw/2026-05-20/*` |
| `mentioned_in` | A → B | A appears in B (often auto-extracted by implicit graph) | `voyage-3.5` mentioned_in `2026-05-20-embedding-provider-choice` |
| `linked` | A → B | Generic association; least specific. Inline `[[wikilinks]]` create implicit linked edges. | Use only when no more-specific type applies |

When in doubt, pick the more specific edge. `linked` is the fallback. `mentions` is also accepted as a backwards-compatible auto-write key for raw observations and is treated as a generic mention edge.

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

The consolidation pipeline continues to auto-write string shorthand under `relations.mentions` by default. Humans and future tools may write rich object entries when relation metadata matters.

### Temporal fields

- `valid_from`: ISO date or datetime when the edge became valid. If omitted, readers may default to the source document's `created` date.
- `valid_to`: ISO date or datetime when the edge stopped being current. `null` or omission means the edge is currently valid.
- `superseded_by`: target page path for the edge that replaced this one.

### Source fields

Object-form edges may include `source` metadata:

- `source.agent`: tool or agent that captured the edge (`codex`, `claude-code`, `antigravity`, `manual`, etc.).
- `source.session_id`: session that produced the relation.
- `source.captured_at`: ISO datetime when the relation was captured.

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

When `memory compile` runs (manually or via scheduled task), the LLM performs:

1. **Read raw observations** since the last compile (per `log.md`'s last `## [date] compile` entry).
2. **Extract entities and themes.** For each candidate entity, check if a wiki page already exists.
3. **Update existing pages** with new content under a `## [YYYY-MM-DD] update` heading. Preserve all prior content.
4. **Create new pages** only when the cross-session signal threshold is met (see §6).
5. **Update `index.md`** if pages were added or titles changed.
6. **Append to `log.md`** a single line: `## [YYYY-MM-DD HH:MM] compile | N raw sessions → M wiki updates, K new pages`.
7. **Apply privacy filter** on every page mutation (§7).
8. **Propose graph edges** (implicit graph extraction, Phase 3+): for each entity pair the LLM identifies, suggest an edge type with confidence; write proposals to `relations-proposals.md` for human review.

The LLM doing compile is whichever agent the user is in (Claude Code / Codex / Antigravity) when `memory compile` is invoked. No separate "compile daemon."

---

## 9. Lint rules

`memory lint` checks the wiki for hygiene issues and emits `lint-report.md`:

| Check | What it flags |
|---|---|
| Frontmatter validity | Missing required fields; unknown `type:`; malformed dates; unknown `status:` |
| Orphan pages | Pages with no inbound `[[wikilinks]]` AND no inbound `relations:` references |
| Broken links | `[[wikilinks]]` whose target page does not exist |
| Stale pages | `status: active` AND `updated` > 180 days ago |
| Contradictions | Pages whose `relations.contradicts` resolves to another page, unresolved |
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
- **Add new edge types** beyond the nine in §5. If a new relationship type seems needed, propose it via `lint-report.md` for schema version bump.

---

## 11. User identity & preferences

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

## 12. Versioning

This file's frontmatter declares `schema_version`. When the schema changes in a way that affects existing wiki pages (new required fields, removed entity types, renamed edge types), increment the version:

- **Patch increment** (e.g., 1 → 1.0.1): docs/wording tweaks; existing pages still valid.
- **Minor increment** (1.0 → 1.1): new optional fields, new edge types; old pages remain valid without migration.
- **Major increment** (1 → 2): breaking change; old pages need migration. The compile workflow on first run after a major bump runs a migration pass and writes `migration-log.md`.

Schema changes are reviewed via `git diff` — the user sees the change, decides if it warrants a version bump, commits both the schema change and the version increment in one commit.

---

*This template is copied by `memory init` into `~/.memory/schema.md` with template variables (`{{user_name}}`, `{{user_email}}`, `{{install_date}}`, `{{github_handle}}`, `{{install_commit}}`) substituted at copy time. After install, this file is the user's to edit — `memory init --reset` preserves a backup before overwriting.*
