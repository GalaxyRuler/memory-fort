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

export interface InvalidParamsBody {
  readonly error: "invalid_params";
  readonly invalid_params: string[];
}

export interface ValidatedSearchFilters {
  readonly scope: SearchScope;
  readonly includeArchived: boolean;
  readonly identityMode: "inclusive" | "strict";
}

export type SearchFilterValidation =
  | { readonly ok: true; readonly filters: ValidatedSearchFilters }
  | { readonly ok: false; readonly body: InvalidParamsBody };

const SEARCH_SCOPES = new Set<SearchScope>(["all", "wiki", "raw", "crystals"]);
const IDENTITY_MODES = new Set(["inclusive", "strict"]);

const SEARCH_BACKENDS = new Set<SearchBackend>(["legacy", "index-lexical", "index-hybrid"]);
const MAX_SEARCH_CAPABILITY_PARAMS = 32;
const MAX_SEARCH_CAPABILITY_PARAM_LENGTH = 128;
const MAX_SEARCH_CAPABILITY_SCOPES = 4;
export function validateSearchFilterParams(url: URL): SearchFilterValidation {
  const scope = url.searchParams.get("scope");
  const identityMode = url.searchParams.get("identity_mode");
  const includeArchived = url.searchParams.get("includeArchived");
  const invalidParams = [
    ...(scope !== null && !SEARCH_SCOPES.has(scope as SearchScope) ? ["scope"] : []),
    ...(identityMode !== null && !IDENTITY_MODES.has(identityMode) ? ["identity_mode"] : []),
    ...(includeArchived !== null && includeArchived !== "true" && includeArchived !== "false"
      ? ["includeArchived"]
      : []),
  ];
  if (invalidParams.length > 0) {
    return { ok: false, body: { error: "invalid_params", invalid_params: invalidParams } };
  }
  return {
    ok: true,
    filters: {
      scope: (scope as SearchScope | null) ?? "all",
      includeArchived: includeArchived === "true",
      identityMode: (identityMode as "inclusive" | "strict" | null) ?? "inclusive",
    },
  };
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

/**
 * Validate untrusted dashboard capability JSON before a consumer uses it.
 * The bounded normalization keeps UI and MCP consumers from treating an
 * arbitrary successful HTTP response as authoritative capability data.
 */
export function parseSearchCapabilities(value: unknown): SearchCapabilities {
  if (!isRecord(value)) throw new TypeError("invalid search capabilities response");
  const searchBackend = value["searchBackend"];
  const supportedParams = parseCapabilityStringArray(value["supportedParams"], MAX_SEARCH_CAPABILITY_PARAMS);
  const unsupportedParams = parseCapabilityStringArray(value["unsupportedParams"], MAX_SEARCH_CAPABILITY_PARAMS);
  const scopes = parseCapabilityStringArray(value["scopes"], MAX_SEARCH_CAPABILITY_SCOPES);
  if (
    typeof searchBackend !== "string"
    || !SEARCH_BACKENDS.has(searchBackend as SearchBackend)
    || supportedParams === null
    || unsupportedParams === null
    || scopes === null
    || scopes.length === 0
    || !scopes.every((scope) => SEARCH_SCOPES.has(scope as SearchScope))
  ) {
    throw new TypeError("invalid search capabilities response");
  }
  return {
    searchBackend: searchBackend as SearchBackend,
    supportedParams,
    unsupportedParams,
    scopes: scopes as SearchScope[],
  };
}

function parseCapabilityStringArray(value: unknown, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxLength) return null;
  const parsed: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > MAX_SEARCH_CAPABILITY_PARAM_LENGTH) {
      return null;
    }
    parsed.push(item);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return INDEX_UNSUPPORTED_SEARCH_PARAMS.filter((param) => url.searchParams.has(param));
}

export function unsupportedParamsBody(
  unsupportedParams: readonly string[],
): UnsupportedParamsBody {
  return {
    error: "unsupported_params",
    unsupported_params: [...unsupportedParams],
  };
}
