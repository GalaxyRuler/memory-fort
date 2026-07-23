"""Standalone capability-parser validation without pytest or respx."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from memory_fort import MemoryFortClient


def valid_capabilities() -> dict[str, Any]:
    return {
        "searchBackend": "index-lexical",
        "supportedParams": ["q"],
        "unsupportedParams": [],
        "scopes": ["all", "wiki", "raw", "crystals"],
    }


async def parser_rejects(case: str, payload: dict[str, Any]) -> bool:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    client = MemoryFortClient(base_url="http://memory.test")
    await client._client.aclose()
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        try:
            await client.search_capabilities()
        except ValueError as error:
            if "invalid search capabilities" not in str(error):
                raise AssertionError(f"{case}: unexpected error: {error}") from error
            return True
        return False
    finally:
        await client.aclose()


async def main() -> None:
    cases: list[tuple[str, dict[str, Any]]] = []

    oversized_supported = valid_capabilities()
    oversized_supported["supportedParams"] = ["q"] * 33
    cases.append(("oversized supportedParams", oversized_supported))

    empty_scopes = valid_capabilities()
    empty_scopes["scopes"] = []
    cases.append(("empty scopes", empty_scopes))

    empty_parameter = valid_capabilities()
    empty_parameter["supportedParams"] = [""]
    cases.append(("empty parameter name", empty_parameter))

    overlong_parameter = valid_capabilities()
    overlong_parameter["unsupportedParams"] = ["p" * 129]
    cases.append(("overlong parameter name", overlong_parameter))

    accepted = [case for case, payload in cases if not await parser_rejects(case, payload)]
    if accepted:
        raise AssertionError(f"accepted invalid capability payloads: {', '.join(accepted)}")
    print("standalone capability parser validation passed")


if __name__ == "__main__":
    asyncio.run(main())
