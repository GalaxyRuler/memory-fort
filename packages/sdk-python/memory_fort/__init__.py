from __future__ import annotations

import math
from typing import Any, Literal, TypedDict, cast

import httpx

__all__ = [
    "MemoryFortClient",
    "MemoryFortError",
    "SearchCapabilities",
    "SearchScope",
    "IdentityMode",
    "ProvenanceReceipt",
    "parse_provenance_receipt",
]

SearchScope = Literal["all", "wiki", "raw", "crystals"]
IdentityMode = Literal["inclusive", "strict"]


class ProvenanceSignal(TypedDict):
    source: str
    rank: int


class AppliedProvenanceFilters(TypedDict):
    includeArchived: bool | None
    asOf: str | None
    agentId: str | None
    userId: str | None
    identityMode: IdentityMode | None


class _RequiredProvenanceReceipt(TypedDict):
    path: str
    kind: Literal["wiki", "raw", "crystal"]
    dominantSource: str
    signals: list[ProvenanceSignal]
    confidence: float | None
    sourceFactCount: int | None
    derivedFromCount: int | None
    tier: Literal["high", "medium", "low"] | None


class ProvenanceReceipt(_RequiredProvenanceReceipt, total=False):
    confidenceMetadata: Any
    validation: str | None
    chunkId: str | None
    chunkOrdinal: int | None
    byteStart: int | None
    byteEnd: int | None
    sourceContentHash: str | None
    chunkTextHash: str | None
    indexGeneration: int | None
    indexedAt: str | None
    createdAt: str | None
    updatedAt: str | None
    observedAt: str | None
    lexicalRank: int | None
    lexicalScore: float | None
    vectorRank: int | None
    vectorDistance: float | None
    appliedScope: SearchScope | None
    appliedFilters: AppliedProvenanceFilters | None
    backend: Literal["legacy", "index-lexical", "index-hybrid"] | None
    rankingProfile: str | None


_SEARCH_CAPABILITY_BACKENDS = ("legacy", "index-lexical", "index-hybrid")
_SEARCH_CAPABILITY_SCOPES = ("all", "wiki", "raw", "crystals")
_MAX_SEARCH_CAPABILITY_PARAMS = 32
_MAX_SEARCH_CAPABILITY_PARAM_LENGTH = 128
_MAX_SEARCH_CAPABILITY_SCOPES = 4



class SearchCapabilities(TypedDict):
    searchBackend: Literal["legacy", "index-lexical", "index-hybrid"]
    supportedParams: list[str]
    unsupportedParams: list[str]
    scopes: list[SearchScope]



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
        scope: SearchScope | None = None,
        agent_id: str | None = None,
        user_id: str | None = None,
        as_of: str | None = None,
        identity_mode: IdentityMode | None = None,
        include_archived: bool | None = None,
    ) -> list[dict[str, Any]]:
        if scope is not None and scope not in ("all", "wiki", "raw", "crystals"):
            raise ValueError(f"invalid scope: {scope}")
        if identity_mode is not None and identity_mode not in ("inclusive", "strict"):
            raise ValueError(f"invalid identity_mode: {identity_mode}")
        if include_archived is not None and type(include_archived) is not bool:
            raise TypeError(f"invalid include_archived: {include_archived}")

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
        if include_archived is not None:
            params["includeArchived"] = str(include_archived).lower()
        res = await self._client.get(f"{self._base}/api/search", params=params)
        data = await self._checked(res)
        results = data.get("results", [])
        if not isinstance(results, list):
            raise ValueError("invalid search response")
        parsed: list[dict[str, Any]] = []
        for result in results:
            if not isinstance(result, dict):
                raise ValueError("invalid search response")
            if "provenance" in result:
                parsed.append(
                    {**result, "provenance": parse_provenance_receipt(result["provenance"])}
                )
            else:
                parsed.append(result)
        return parsed

    async def search_capabilities(self) -> SearchCapabilities:
        res = await self._client.get(f"{self._base}/api/search/capabilities")
        data = await self._checked(res)
        return _parse_search_capabilities(data)

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


def _parse_search_capabilities(data: Any) -> SearchCapabilities:
    if not isinstance(data, dict):
        raise ValueError("invalid search capabilities response")
    backend = data.get("searchBackend")
    supported = _parse_capability_string_list(
        data.get("supportedParams"), _MAX_SEARCH_CAPABILITY_PARAMS
    )
    unsupported = _parse_capability_string_list(
        data.get("unsupportedParams"), _MAX_SEARCH_CAPABILITY_PARAMS
    )
    scopes = _parse_capability_string_list(
        data.get("scopes"), _MAX_SEARCH_CAPABILITY_SCOPES
    )
    if (
        backend not in _SEARCH_CAPABILITY_BACKENDS
        or supported is None
        or unsupported is None
        or scopes is None
        or not scopes
        or any(scope not in _SEARCH_CAPABILITY_SCOPES for scope in scopes)
    ):
        raise ValueError("invalid search capabilities response")
    return cast(SearchCapabilities, {
        "searchBackend": backend,
        "supportedParams": supported,
        "unsupportedParams": unsupported,
        "scopes": scopes,
    })


def _parse_capability_string_list(value: Any, max_items: int) -> list[str] | None:
    if not isinstance(value, list) or len(value) > max_items:
        return None
    parsed: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item or len(item) > _MAX_SEARCH_CAPABILITY_PARAM_LENGTH:
            return None
        parsed.append(item)
    return parsed


_PROVENANCE_KINDS = ("wiki", "raw", "crystal")
_PROVENANCE_TIERS = ("high", "medium", "low")
_PROVENANCE_BACKENDS = ("legacy", "index-lexical", "index-hybrid")
_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")


def parse_provenance_receipt(value: Any) -> ProvenanceReceipt:
    if not isinstance(value, dict):
        raise _invalid_provenance_receipt()
    signals = value.get("signals")
    if (
        not _nonempty_string(value.get("path"))
        or value.get("kind") not in _PROVENANCE_KINDS
        or not _nonempty_string(value.get("dominantSource"))
        or not isinstance(signals, list)
        or not all(_valid_provenance_signal(signal) for signal in signals)
        or not _valid_confidence(value.get("confidence"))
        or not _nullable_nonnegative_int(value.get("sourceFactCount"))
        or not _nullable_nonnegative_int(value.get("derivedFromCount"))
        or value.get("tier") not in (*_PROVENANCE_TIERS, None)
    ):
        raise _invalid_provenance_receipt()
    _validate_optional_provenance_fields(value)
    return cast(ProvenanceReceipt, value)


def _validate_optional_provenance_fields(value: dict[str, Any]) -> None:
    for key in (
        "chunkOrdinal",
        "byteStart",
        "byteEnd",
        "indexGeneration",
        "lexicalRank",
        "vectorRank",
    ):
        if key in value and not _nullable_nonnegative_int(value[key]):
            raise _invalid_provenance_receipt()
    for key in ("lexicalScore", "vectorDistance"):
        if key in value and not _nullable_finite_number(value[key]):
            raise _invalid_provenance_receipt()
    for key in (
        "chunkId",
        "indexedAt",
        "createdAt",
        "updatedAt",
        "observedAt",
        "rankingProfile",
        "validation",
    ):
        if key in value and not _nullable_string(value[key]):
            raise _invalid_provenance_receipt()
    for key in ("sourceContentHash", "chunkTextHash"):
        if key in value and not _nullable_hash(value[key]):
            raise _invalid_provenance_receipt()
    byte_start = value.get("byteStart")
    byte_end = value.get("byteEnd")
    if type(byte_start) is int and type(byte_end) is int and byte_end <= byte_start:
        raise _invalid_provenance_receipt()
    if "appliedScope" in value and value["appliedScope"] not in (*_SEARCH_CAPABILITY_SCOPES, None):
        raise _invalid_provenance_receipt()
    if "backend" in value and value["backend"] not in (*_PROVENANCE_BACKENDS, None):
        raise _invalid_provenance_receipt()
    if "appliedFilters" in value and not _valid_applied_filters(value["appliedFilters"]):
        raise _invalid_provenance_receipt()


def _valid_provenance_signal(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and _nonempty_string(value.get("source"))
        and type(value.get("rank")) is int
        and value["rank"] >= 0
    )


def _valid_applied_filters(value: Any) -> bool:
    if value is None:
        return True
    return (
        isinstance(value, dict)
        and (value.get("includeArchived") is None or type(value.get("includeArchived")) is bool)
        and _nullable_string(value.get("asOf"))
        and _nullable_string(value.get("agentId"))
        and _nullable_string(value.get("userId"))
        and value.get("identityMode") in ("inclusive", "strict", None)
    )


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def _nullable_string(value: Any) -> bool:
    return value is None or isinstance(value, str)


def _valid_confidence(value: Any) -> bool:
    return value is None or (_nullable_finite_number(value) and 0 <= value <= 1)


def _nullable_finite_number(value: Any) -> bool:
    return value is None or (type(value) in (int, float) and math.isfinite(value))


def _nullable_nonnegative_int(value: Any) -> bool:
    return value is None or (type(value) is int and value >= 0)


def _nullable_hash(value: Any) -> bool:
    return value is None or (isinstance(value, str) and len(value) == 64 and set(value) <= _HEX_DIGITS)


def _invalid_provenance_receipt() -> ValueError:
    return ValueError("invalid provenance receipt")
