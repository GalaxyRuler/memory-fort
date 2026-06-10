# memory-fort-sdk

TypeScript client for [Memory Fort](https://github.com/GalaxyRuler/memory-fort) — search, log, and retrieve from your personal memory vault.

## Install

```bash
npm install memory-fort-sdk
```

## Usage

```typescript
import { MemoryFortClient } from "memory-fort-sdk";

const client = new MemoryFortClient();

// One-liner to log a memory
await client.add("Switched from ESLint to Biome");

// Search
const results = await client.search("voyage embeddings", { k: 5 });

// Temporal + identity-scoped search
const q1 = await client.search("project stack", {
  asOf: "2026-03-01",
  agentId: "codex-prod",
  identityMode: "inclusive",
});

// List pages
const pages = await client.listPages({ type: "tools" });
```

Requires a running Memory Fort dashboard (`memory-fort dashboard`), default base URL `http://127.0.0.1:4410/memory`.

## Troubleshooting

**`MemoryFortError: read-only mirror` (HTTP 403) on `add()`** — write endpoints require the vault directory to be a git repository. Vaults created by `memory-fort init` already are; for a hand-made vault, run `git init` inside it. Read operations (`search`, `listPages`) work either way.

## Identity filtering

`identityMode: "inclusive"` (default) — untagged documents (curated wiki pages) always pass through; only tagged documents are filtered by identity match. `identityMode: "strict"` — only documents with matching identity tags are returned. Identity filtering is a retrieval preference, NOT security isolation.

## License

GPL-3.0-only
