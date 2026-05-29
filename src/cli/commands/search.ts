import { loadMemoryConfig } from "../../storage/config.js";

export interface CliSearchOptions {
  scope?: "wiki" | "raw" | "crystals" | "all";
  k?: number;
  minScore?: number;
  noRerank?: boolean;
  json?: boolean;
  vpsUrl?: string;
  fetchFn?: typeof fetch;
  configLoader?: () => Promise<{ vps?: { host?: string } }>;
}

export interface CliSearchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ApiSearchResult {
  path: string;
  snippet?: string;
  score?: number;
  source?: string;
}

interface ApiSearchResponse {
  query: string;
  results: ApiSearchResult[];
  warnings?: string[];
  timings?: { totalMs?: number };
  degraded?: boolean;
}

const DEFAULT_VPS_URL = "https://srv1317946.tail6916d8.ts.net/memory";
const VALID_SCOPES = new Set(["wiki", "raw", "crystals", "all"]);

export async function runSearch(
  query: string,
  opts: CliSearchOptions = {},
): Promise<CliSearchResult> {
  const trimmedQuery = query.trim();
  const validationError = validateOptions(trimmedQuery, opts);
  if (validationError) {
    return { exitCode: 2, stdout: "", stderr: `${validationError}\n` };
  }

  const baseUrl = await resolveVpsUrl(opts);
  const url = buildSearchUrl(baseUrl, trimmedQuery, opts);
  const fetchFn = opts.fetchFn ?? fetch;

  let response: Response;
  try {
    response = await fetchFn(url);
  } catch {
    return backendOffline(trimmedQuery);
  }

  if (!response.ok) {
    return backendOffline(trimmedQuery);
  }

  let body: ApiSearchResponse;
  try {
    body = (await response.json()) as ApiSearchResponse;
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Failed to parse search response: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  if (opts.json === true) {
    return { exitCode: 0, stdout: `${JSON.stringify(body, null, 2)}\n`, stderr: "" };
  }

  if (!Array.isArray(body.results) || body.results.length === 0) {
    return {
      exitCode: 0,
      stdout: "",
      stderr: `No results for query: ${trimmedQuery}\n`,
    };
  }

  return { exitCode: 0, stdout: formatPretty(body), stderr: "" };
}

function validateOptions(query: string, opts: CliSearchOptions): string | null {
  if (query.length === 0) return "memory search: query must be non-empty";
  if (opts.scope !== undefined && !VALID_SCOPES.has(opts.scope)) {
    return `memory search: invalid --scope ${opts.scope}. Use wiki, raw, crystals, or all.`;
  }
  if (opts.k !== undefined && (!Number.isInteger(opts.k) || opts.k < 1)) {
    return "memory search: --k must be a positive integer";
  }
  if (opts.minScore !== undefined && (!Number.isFinite(opts.minScore) || opts.minScore < 0 || opts.minScore > 1)) {
    return "memory search: --min-score must be a number between 0 and 1";
  }
  return null;
}

async function resolveVpsUrl(opts: CliSearchOptions): Promise<string> {
  if (opts.vpsUrl) return trimTrailingSlash(opts.vpsUrl);
  const config = await (opts.configLoader ?? loadMemoryConfig)();
  const host = config.vps?.host?.trim();
  if (host) return `https://${host}/memory`;
  return DEFAULT_VPS_URL;
}

function buildSearchUrl(baseUrl: string, query: string, opts: CliSearchOptions): string {
  const url = new URL(`${trimTrailingSlash(baseUrl)}/api/search`);
  url.searchParams.set("q", query);
  if (opts.scope !== undefined) url.searchParams.set("scope", opts.scope);
  if (opts.k !== undefined) url.searchParams.set("k", String(opts.k));
  if (opts.minScore !== undefined) url.searchParams.set("minScore", String(opts.minScore));
  url.searchParams.set("noRerank", String(opts.noRerank ?? true));
  return url.toString();
}

function formatPretty(body: ApiSearchResponse): string {
  const totalMs = body.timings?.totalMs ?? 0;
  const lines = [
    `Query: ${body.query}`,
    `Found ${body.results.length} results in ${totalMs}ms (degraded: ${body.degraded ? "yes" : "no"})`,
  ];

  if (body.warnings && body.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of body.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  body.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.path} [score=${result.score ?? 0} source=${result.source ?? "unknown"}]`);
    lines.push(`   ${truncate(result.snippet ?? "", 200)}`);
  });

  return `${lines.join("\n")}\n`;
}

function backendOffline(query: string): CliSearchResult {
  return {
    exitCode: 3,
    stdout: "",
    stderr:
      "Search backend offline. Confirm VPS reachable via Tailscale " +
      "(try: tailscale ping srv1317946). Memory grep available as offline fallback: " +
      `memory grep '${query}' --scope raw.\n`,
  };
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
