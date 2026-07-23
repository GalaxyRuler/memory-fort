import asyncio
from typing import get_type_hints

import pytest
import httpx

from memory_fort import MemoryFortClient, SearchCapabilities


def test_search_rejects_invalid_filters_before_http():
    async def run() -> None:
        client = MemoryFortClient(base_url="http://127.0.0.1:1")
        try:
            with pytest.raises(ValueError, match="invalid scope"):
                await client.search("test", scope="bogus")
            with pytest.raises(ValueError, match="invalid identity_mode"):
                await client.search("test", identity_mode="bogus")
            with pytest.raises(TypeError, match="invalid include_archived"):
                await client.search("test", include_archived=1)  # type: ignore[arg-type]
        finally:
            await client.aclose()

    asyncio.run(run())

def test_search_capabilities_rejects_arbitrary_json_shape():
    async def run() -> None:
        async def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={"searchBackend": "invented", "supportedParams": "q"},
            )

        client = MemoryFortClient(base_url="http://memory.test")
        await client._client.aclose()
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            with pytest.raises(ValueError, match="invalid search capabilities"):
                await client.search_capabilities()
        finally:
            await client.aclose()

    asyncio.run(run())

def test_search_capabilities_has_an_exported_typed_return():
    hints = get_type_hints(MemoryFortClient.search_capabilities)

    assert hints["return"] is SearchCapabilities
    assert SearchCapabilities.__required_keys__ == {
        "searchBackend", "supportedParams", "unsupportedParams", "scopes"
    }
