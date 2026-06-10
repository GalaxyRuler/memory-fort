import httpx
import pytest
import respx

from memory_fort import MemoryFortClient, MemoryFortError

BASE = "http://127.0.0.1:4410/memory"


@pytest.mark.asyncio
@respx.mock
async def test_search_returns_results():
    respx.get(f"{BASE}/api/search").mock(
        return_value=httpx.Response(
            200, json={"results": [{"path": "wiki/tools/voyage.md", "score": 0.9}]}
        )
    )
    async with MemoryFortClient(base_url=BASE) as client:
        results = await client.search("voyage embeddings")
    assert len(results) == 1
    assert results[0]["path"] == "wiki/tools/voyage.md"


@pytest.mark.asyncio
@respx.mock
async def test_add_sends_post():
    respx.post(f"{BASE}/api/observations").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    async with MemoryFortClient(base_url=BASE) as client:
        await client.add("Switched from ESLint to Biome")
    assert respx.calls.last.request.method == "POST"


@pytest.mark.asyncio
@respx.mock
async def test_log_is_alias_for_add():
    respx.post(f"{BASE}/api/observations").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    async with MemoryFortClient(base_url=BASE) as client:
        await client.log("test observation")
    assert "/api/observations" in str(respx.calls.last.request.url)


@pytest.mark.asyncio
@respx.mock
async def test_search_passes_identity_and_temporal_params():
    respx.get(f"{BASE}/api/search").mock(
        return_value=httpx.Response(200, json={"results": []})
    )
    async with MemoryFortClient(base_url=BASE) as client:
        await client.search(
            "test",
            agent_id="codex",
            user_id="alice",
            as_of="2026-01-01",
            identity_mode="strict",
        )
    request = respx.calls.last.request
    assert request.url.params["agent_id"] == "codex"
    assert request.url.params["user_id"] == "alice"
    assert request.url.params["as_of"] == "2026-01-01"
    assert request.url.params["identity_mode"] == "strict"


@pytest.mark.asyncio
@respx.mock
async def test_add_passes_tags_and_confidence():
    route = respx.post(f"{BASE}/api/observations").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    async with MemoryFortClient(base_url=BASE) as client:
        await client.add("tagged", tags=["infra"], confidence=0.9)
    import json

    sent = json.loads(route.calls.last.request.content)
    assert sent["tags"] == ["infra"]
    assert sent["confidence"] == 0.9


@pytest.mark.asyncio
@respx.mock
async def test_list_pages_passes_type():
    respx.get(f"{BASE}/api/pages").mock(
        return_value=httpx.Response(200, json={"pages": [{"path": "wiki/tools/a.md", "title": "A"}]})
    )
    async with MemoryFortClient(base_url=BASE) as client:
        pages = await client.list_pages(type="tools")
    assert respx.calls.last.request.url.params["type"] == "tools"
    assert pages[0]["title"] == "A"


@pytest.mark.asyncio
@respx.mock
async def test_raises_on_error():
    respx.get(f"{BASE}/api/search").mock(
        return_value=httpx.Response(404, json={"error": "vault not found"})
    )
    async with MemoryFortClient(base_url=BASE) as client:
        with pytest.raises(MemoryFortError, match="vault not found"):
            await client.search("test")
