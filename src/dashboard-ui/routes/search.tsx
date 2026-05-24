import { createFileRoute } from "@tanstack/react-router";
import { SearchPage } from "../components/SearchPage.js";
import { type SearchScope } from "../hooks/useSearch.js";

export const Route = createFileRoute("/search")({
  component: SearchPage,
  validateSearch: (search): SearchPageSearch => ({
    q: typeof search.q === "string" ? search.q : undefined,
    scope: isSearchScope(search.scope) ? search.scope : undefined,
    k: parseK(search.k),
    noRerank: search.noRerank === true || search.noRerank === "true" ? true : undefined,
  }),
});

export interface SearchPageSearch {
  q?: string;
  scope?: SearchScope;
  k?: number;
  noRerank?: boolean;
}

function isSearchScope(value: unknown): value is SearchScope {
  return value === "all" || value === "wiki" || value === "raw" || value === "crystals";
}

function parseK(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
