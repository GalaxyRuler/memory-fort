# memory-fort

Python async client for [Memory Fort](https://github.com/GalaxyRuler/memory-fort) — search, log, and retrieve from your personal memory vault.

## Install

```bash
pip install memory-fort
```

## Usage

```python
from memory_fort import MemoryFortClient

async with MemoryFortClient() as client:
    await client.add("Switched from ESLint to Biome")
    results = await client.search("voyage embeddings", k=5)
    pages = await client.list_pages(type="tools")

    # Temporal + identity-scoped search
    q1 = await client.search(
        "project stack",
        as_of="2026-03-01",
        agent_id="codex-prod",
        identity_mode="inclusive",
    )
```

Requires a running Memory Fort dashboard (`memory-fort dashboard`), default base URL `http://127.0.0.1:4410/memory`.

## Identity filtering

`identity_mode="inclusive"` (default) — untagged documents (curated wiki pages) always pass through; only tagged documents are filtered by identity match. `identity_mode="strict"` — only documents with matching identity tags are returned. Identity filtering is a retrieval preference, NOT security isolation.

## License

GPL-3.0-only
