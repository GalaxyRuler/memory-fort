# Curation workflow

How to turn accumulated raw observations into a curated knowledge graph.

## Prerequisites

- `memory init` has been run
- At least one of `memory install <platform>` has been run
- Raw observations have accumulated under `~/.memory/raw/<date>/`

## The loop

1. **Inspect what's accumulated.** Use `memory stats`, `memory grep`, or direct file reads under `~/.memory/raw/` to understand what recent sessions produced. Check `~/.memory/log.md` for the last compile entry if you want to know what has already been folded into the wiki.
2. **Run compile.** Run `memory compile` and give the printed prompt to the active agent session. The command only assembles context; the LLM reads the prompt, applies the schema, and proposes wiki edits.
3. **Review the LLM's work.** Read the diff before letting it land. Look for over-created pages, invented relations, weak titles, stale claims, and missing `updated:` changes.
4. **Run lint.** Use `memory lint` for an LLM-guided report, or `memory lint --checks-only` for deterministic checks. Fix frontmatter and broken relations before starting another compile pass.
5. **Read individual pages.** Use `memory page <target>` to inspect one page with its outbound relations and inbound references resolved. This is useful before archiving, renaming, or adding new relations.
6. **Iterate.** Compile turns raw sessions into wiki changes; lint checks the graph; page helps inspect a local neighborhood. Repeat after meaningful work sessions rather than after every tiny note.

## When to compile

Compile after a working session or cluster of sessions has produced several raw observations. The raw files do not need to be manually summarized first; `memory compile` gathers the relevant raw content, schema, index, and recent log lines into one prompt.

Check `~/.memory/log.md` to see what was last compiled. If you omit `--since`, the CLI starts from the latest compile log entry, or from the epoch if there is none. The LLM enforces the cross-session threshold for you: a new wiki page should usually require 3 or more raw mentions across sessions, unless the prompt gives a narrower exception.

## When to lint

Lint after every compile pass, before the next compile cycle. Broken relations and orphan pages accumulate quickly when wiki edits are not checked.

Use `memory lint --checks-only` when you want a fast mechanical report in a terminal or script. Use `memory lint` when you want the active agent session to make judgment calls: which stale pages matter, which drafts should be promoted, which contradictions need a decision, and which issues should be handled first.

## When to page

Use `memory page <target>` before deciding to archive a page. The inbound section shows whether other pages still rely on it.

Use it before adding a relation to a page. Reading the page first shows what it already says, which relations already exist, and whether the filename-only target you had in mind resolves to the page you intended. Use `--no-inbound` when you only need the page body and outbound relations.

## Anti-patterns

- Running `memory compile` and pasting the prompt without reading the LLM's diff before letting it land in `wiki/`. The LLM might over-create pages or invent relations.
- Skipping lint between compile cycles. Broken relations and orphan pages accumulate quickly when wiki edits aren't checked.
- Treating `lint --checks-only` as a substitute for the LLM lint pass. Programmatic checks catch mechanics; the LLM catches judgment calls (contradictions, drafts that should be promoted, stale claims).
- Editing wiki pages by hand without updating the `updated:` frontmatter field. Stale-page detection relies on it.

## Future commands (Phase 3+)

- `memory search` — hybrid retrieval (BM25 + voyage-4-large + rerank + graph). Phase 3.
- `memory crystallize` — distill a completed thread into a long-form digest. Phase 4.

See [architecture.md](architecture.md) for the data flow, [cli.md](cli.md) for command reference.
