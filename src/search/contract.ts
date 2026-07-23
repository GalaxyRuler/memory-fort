import type { SearchBackend } from "../retrieval/search.js";
import type { SearchScope } from "../retrieval/corpus.js";

export const INDEX_UNSUPPORTED_SEARCH_PARAMS = [
  "minScore",
  "noRerank",
  "noHyde",
  "hydeExpansion",
  "intent",
] as const;

export type UnsupportedSearchParam = typeof INDEX_UNSUPPORTED_SEARCH_PARAMS[number];

export interface UnsupportedParamsBody {
  readonly error: "unsupported_params";
  readonly unsupported_params: string[];
}

export const INDEX_SUPPORTED_SEARCH_PARAMS = [
  "q",
  "limit",
  "k",
  "cursor",
  "scope",
  "includeArchived",
  "as_of",
  "agent_id",
  "user_id",
  "identity_mode",
] as const;

export const LEGACY_SUPPORTED_SEARCH_PARAMS = [
  "q",
  "k",
  "scope",
  "minScore",
  "noRerank",
  "noHyde",
  "hydeExpansion",
  "intent",
  "as_of",
  "agent_id",
  "user_id",
  "identity_mode",
] as const;

export interface SearchCapabilities {
  readonly searchBackend: SearchBackend;
  readonly supportedParams: readonly string[];
  readonly unsupportedParams: readonly string[];
  readonly scopes: readonly SearchScope[];
}

export function capabilitiesForSearchBackend(searchBackend: SearchBackend): SearchCapabilities {
  const index = searchBackend !== "legacy";
  return {
    searchBackend,
    supportedParams: index ? INDEX_SUPPORTED_SEARCH_PARAMS : LEGACY_SUPPORTED_SEARCH_PARAMS,
    unsupportedParams: index ? INDEX_UNSUPPORTED_SEARCH_PARAMS : ["includeArchived"],
    scopes: ["all", "wiki", "raw", "crystals"],
  };
}

export function collectUnsupportedIndexSearchParams(url: URL): UnsupportedSearchParam[] {
  return INDEX_UNSUPPORTED_SEARCH_PARAMS.filter((param) => {
    const value = url.searchParams.get(param);
    return value !== null && (param === "noRerank" || param === "noHyde" || value.trim().length > 0);
  });
}

export function unsupportedParamsBody(
  unsupportedParams: readonly string[],
): UnsupportedParamsBody {
  return {
    error: "unsupported_params",
    unsupported_params: [...unsupportedParams],
  };
}
