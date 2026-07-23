export class MemoryFortError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "MemoryFortError";
  }
}

export interface MemoryFortClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export type ProvenanceTier = "high" | "medium" | "low";

export interface ProvenanceSignal {
  source: string;
  rank: number;
}

export interface ProvenanceReceipt {
  path: string;
  kind: "wiki" | "raw" | "crystal";
  dominantSource: string;
  signals: ProvenanceSignal[];
  confidence: number | null;
  confidenceMetadata?: unknown;
  validation?: string | null;
  sourceFactCount: number | null;
  derivedFromCount: number | null;
  tier: ProvenanceTier | null;
  chunkId?: string | null;
  chunkOrdinal?: number | null;
  byteStart?: number | null;
  byteEnd?: number | null;
  sourceContentHash?: string | null;
  chunkTextHash?: string | null;
  indexGeneration?: number | null;
  indexedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  observedAt?: string | null;
  lexicalRank?: number | null;
  lexicalScore?: number | null;
  vectorRank?: number | null;
  vectorDistance?: number | null;
  appliedScope?: SearchScope | null;
  appliedFilters?: {
    includeArchived: boolean | null;
    asOf: string | null;
    agentId: string | null;
    userId: string | null;
    identityMode: "inclusive" | "strict" | null;
  } | null;
  backend?: "legacy" | "index-lexical" | "index-hybrid" | null;
  rankingProfile?: string | null;
}

export interface SearchResult {
  path: string;
  score: number;
  title?: string;
  snippet?: string;
  provenance?: ProvenanceReceipt;
}

export interface PageMeta {
  path: string;
  title: string;
  type?: string;
  updated?: string;
  status?: string;
}

export interface SearchCapabilities {
  searchBackend: "legacy" | "index-lexical" | "index-hybrid";
  supportedParams: string[];
  unsupportedParams: string[];
  scopes: Array<"all" | "wiki" | "raw" | "crystals">;
}
export type SearchScope = "all" | "wiki" | "raw" | "crystals";

export interface SearchOptions {
  k?: number;
  scope?: SearchScope;
  agentId?: string;
  userId?: string;
  asOf?: string;
  identityMode?: "inclusive" | "strict";
  includeArchived?: boolean;
}

export interface LogOptions {
  tags?: string[];
  confidence?: number;
}

async function checked(res: Response): Promise<unknown> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new MemoryFortError(msg, res.status, body);
  }
  return body;
}

export class MemoryFortClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly _fetch: typeof fetch;

  constructor(opts: MemoryFortClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:4410/memory").replace(/\/$/, "");
    this.headers = {
      "content-type": "application/json",
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    };
    this._fetch = opts.fetch ?? globalThis.fetch;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    validateSearchOptions(opts);
    const params = new URLSearchParams({ q: query });
    if (opts.k !== undefined) params.set("k", String(opts.k));
    if (opts.scope) params.set("scope", opts.scope);
    if (opts.agentId) params.set("agent_id", opts.agentId);
    if (opts.userId) params.set("user_id", opts.userId);
    if (opts.asOf) params.set("as_of", opts.asOf);
    if (opts.identityMode) params.set("identity_mode", opts.identityMode);
    if (opts.includeArchived !== undefined) params.set("includeArchived", String(opts.includeArchived));
    const res = await this._fetch(`${this.baseUrl}/api/search?${params}`, {
      headers: this.headers,
    });
    const data = (await checked(res)) as { results?: SearchResult[] };
    return (data.results ?? []).map((result) => result.provenance === undefined
      ? result
      : { ...result, provenance: parseProvenanceReceipt(result.provenance) });
  }

  async searchCapabilities(): Promise<SearchCapabilities> {
    const res = await this._fetch(`${this.baseUrl}/api/search/capabilities`, {
      headers: this.headers,
    });
    return parseSearchCapabilities(await checked(res));
  }

  async add(text: string, opts: LogOptions = {}): Promise<void> {
    const res = await this._fetch(`${this.baseUrl}/api/observations`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ text, ...opts }),
    });
    await checked(res);
  }

  async log(text: string, opts: LogOptions = {}): Promise<void> {
    return this.add(text, opts);
  }

  async listPages(opts: { type?: string } = {}): Promise<PageMeta[]> {
    const params = new URLSearchParams();
    if (opts.type) params.set("type", opts.type);
    const query = params.toString() ? `?${params}` : "";
    const res = await this._fetch(`${this.baseUrl}/api/pages${query}`, {
      headers: this.headers,
    });
    const data = (await checked(res)) as { pages?: PageMeta[] };
    return data.pages ?? [];
  }
}

export default MemoryFortClient;

function validateSearchOptions(opts: SearchOptions): void {
  if (
    opts.scope !== undefined
    && !["all", "wiki", "raw", "crystals"].includes(opts.scope)
  ) {
    throw new TypeError(`invalid scope: ${String(opts.scope)}`);
  }
  if (
    opts.identityMode !== undefined
    && opts.identityMode !== "inclusive"
    && opts.identityMode !== "strict"
  ) {
    throw new TypeError(`invalid identityMode: ${String(opts.identityMode)}`);
  }
  if (opts.includeArchived !== undefined && typeof opts.includeArchived !== "boolean") {
    throw new TypeError(`invalid includeArchived: ${String(opts.includeArchived)}`);
  }
}

const SEARCH_CAPABILITY_BACKENDS = ["legacy", "index-lexical", "index-hybrid"] as const;
const SEARCH_CAPABILITY_SCOPES = ["all", "wiki", "raw", "crystals"] as const;
const MAX_SEARCH_CAPABILITY_PARAMS = 32;
const MAX_SEARCH_CAPABILITY_PARAM_LENGTH = 128;
const MAX_SEARCH_CAPABILITY_SCOPES = 4;

function parseSearchCapabilities(value: unknown): SearchCapabilities {
  if (!isRecord(value)) throw new TypeError("invalid search capabilities response");
  const searchBackend = value["searchBackend"];
  const supportedParams = parseCapabilityStringArray(value["supportedParams"], MAX_SEARCH_CAPABILITY_PARAMS);
  const unsupportedParams = parseCapabilityStringArray(value["unsupportedParams"], MAX_SEARCH_CAPABILITY_PARAMS);
  const scopes = parseCapabilityStringArray(value["scopes"], MAX_SEARCH_CAPABILITY_SCOPES);
  if (
    !isSearchCapabilityBackend(searchBackend)
    || supportedParams === null
    || unsupportedParams === null
    || scopes === null
    || scopes.length === 0
    || !scopes.every(isSearchCapabilityScope)
  ) {
    throw new TypeError("invalid search capabilities response");
  }
  return {
    searchBackend,
    supportedParams,
    unsupportedParams,
    scopes,
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

function isSearchCapabilityBackend(value: unknown): value is SearchCapabilities["searchBackend"] {
  return typeof value === "string" && SEARCH_CAPABILITY_BACKENDS.includes(value as SearchCapabilities["searchBackend"]);
}

function isSearchCapabilityScope(value: string): value is SearchScope {
  return SEARCH_CAPABILITY_SCOPES.includes(value as SearchScope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROVENANCE_KINDS = ["wiki", "raw", "crystal"] as const;
const PROVENANCE_TIERS = ["high", "medium", "low"] as const;
const PROVENANCE_BACKENDS = ["legacy", "index-lexical", "index-hybrid"] as const;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;

export function parseProvenanceReceipt(value: unknown): ProvenanceReceipt {
  if (!isRecord(value)) throw invalidProvenanceReceipt();
  const signals = value["signals"];
  if (
    !isNonEmptyString(value["path"])
    || !PROVENANCE_KINDS.includes(value["kind"] as ProvenanceReceipt["kind"])
    || !isNonEmptyString(value["dominantSource"])
    || !Array.isArray(signals)
    || !signals.every(isProvenanceSignal)
    || !isConfidence(value["confidence"])
    || !isNullableNonNegativeInteger(value["sourceFactCount"])
    || !isNullableNonNegativeInteger(value["derivedFromCount"])
    || !(value["tier"] === null || PROVENANCE_TIERS.includes(value["tier"] as ProvenanceTier))
  ) {
    throw invalidProvenanceReceipt();
  }
  validateOptionalReceiptFields(value);
  return value as unknown as ProvenanceReceipt;
}

function validateOptionalReceiptFields(value: Record<string, unknown>): void {
  for (const key of ["chunkOrdinal", "byteStart", "byteEnd", "indexGeneration", "lexicalRank", "vectorRank"]) {
    if (key in value && !isNullableNonNegativeInteger(value[key])) throw invalidProvenanceReceipt();
  }
  for (const key of ["lexicalScore", "vectorDistance"]) {
    if (key in value && !isNullableFiniteNumber(value[key])) throw invalidProvenanceReceipt();
  }
  for (const key of ["chunkId", "indexedAt", "createdAt", "updatedAt", "observedAt", "rankingProfile", "validation"]) {
    if (key in value && !isNullableString(value[key])) throw invalidProvenanceReceipt();
  }
  for (const key of ["sourceContentHash", "chunkTextHash"]) {
    const field = value[key];
    if (key in value && !(field === null || (typeof field === "string" && HASH_PATTERN.test(field)))) {
      throw invalidProvenanceReceipt();
    }
  }
  if (
    typeof value["byteStart"] === "number"
    && typeof value["byteEnd"] === "number"
    && value["byteEnd"] <= value["byteStart"]
  ) {
    throw invalidProvenanceReceipt();
  }
  if (
    "appliedScope" in value
    && !(value["appliedScope"] === null || isSearchCapabilityScope(value["appliedScope"] as string))
  ) {
    throw invalidProvenanceReceipt();
  }
  if (
    "backend" in value
    && !(value["backend"] === null || PROVENANCE_BACKENDS.includes(value["backend"] as NonNullable<ProvenanceReceipt["backend"]>))
  ) {
    throw invalidProvenanceReceipt();
  }
  if ("appliedFilters" in value && !isAppliedFilters(value["appliedFilters"])) throw invalidProvenanceReceipt();
}

function isProvenanceSignal(value: unknown): value is ProvenanceSignal {
  return isRecord(value)
    && isNonEmptyString(value["source"])
    && Number.isInteger(value["rank"])
    && (value["rank"] as number) >= 0;
}

function isAppliedFilters(value: unknown): value is NonNullable<ProvenanceReceipt["appliedFilters"]> | null {
  if (value === null) return true;
  return isRecord(value)
    && (value["includeArchived"] === null || typeof value["includeArchived"] === "boolean")
    && isNullableString(value["asOf"])
    && isNullableString(value["agentId"])
    && isNullableString(value["userId"])
    && (value["identityMode"] === null || value["identityMode"] === "inclusive" || value["identityMode"] === "strict");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isConfidence(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && (value as number) >= 0);
}

function invalidProvenanceReceipt(): TypeError {
  return new TypeError("invalid provenance receipt");
}
