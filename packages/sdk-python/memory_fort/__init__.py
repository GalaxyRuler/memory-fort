from __future__ import annotations

from typing import Any

import httpx

__all__ = ["MemoryFortClient", "MemoryFortError"]


class MemoryFortError(Exception):
    def __init__(self, message: str, status: int, body: Any) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class MemoryFortClient:
    """Async client for the Memory Fort local HTTP API."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:4410/memory",
        api_key: str | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        headers: dict[str, str] = {"content-type": "application/json"}
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"
        self._client = httpx.AsyncClient(headers=headers)

    async def _checked(self, response: httpx.Response) -> Any:
        body: Any = {}
        try:
            body = response.json()
        except Exception:
            pass
        if not response.is_success:
            msg = body.get("error") if isinstance(body, dict) else None
            raise MemoryFortError(
                msg or f"HTTP {response.status_code}", response.status_code, body
            )
        return body

    async def search(
        self,
        query: str,
        *,
        k: int | None = None,
        scope: str | None = None,
        agent_id: str | None = None,
        user_id: str | None = None,
        as_of: str | None = None,
        identity_mode: str | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, str] = {"q": query}
        if k is not None:
            params["k"] = str(k)
        if scope:
            params["scope"] = scope
        if agent_id:
            params["agent_id"] = agent_id
        if user_id:
            params["user_id"] = user_id
        if as_of:
            params["as_of"] = as_of
        if identity_mode:
            params["identity_mode"] = identity_mode
        res = await self._client.get(f"{self._base}/api/search", params=params)
        data = await self._checked(res)
        return data.get("results", [])

    async def add(
        self,
        text: str,
        *,
        tags: list[str] | None = None,
        confidence: float | None = None,
    ) -> None:
        payload: dict[str, Any] = {"text": text}
        if tags is not None:
            payload["tags"] = tags
        if confidence is not None:
            payload["confidence"] = confidence
        res = await self._client.post(f"{self._base}/api/observations", json=payload)
        await self._checked(res)

    async def log(self, text: str, **kwargs: Any) -> None:
        await self.add(text, **kwargs)

    async def list_pages(self, *, type: str | None = None) -> list[dict[str, Any]]:
        params: dict[str, str] = {}
        if type:
            params["type"] = type
        res = await self._client.get(f"{self._base}/api/pages", params=params)
        data = await self._checked(res)
        return data.get("pages", [])

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "MemoryFortClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()
