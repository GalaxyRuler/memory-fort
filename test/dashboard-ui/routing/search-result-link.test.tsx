import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SearchResultCard } from "../../../src/dashboard-ui/components/SearchResultCard.js";
import type { SearchResult } from "../../../src/dashboard-ui/hooks/useSearch.js";
import { parseIncludeArchivedQuery } from "../../../src/search/contract.js";

describe("SearchResultCard real router link grammar", () => {
  test("uses the canonical archive query and leaves live wiki links query-free", async () => {
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <SearchResultCard result={wikiResult("wiki/archive/old.md", "Archived Project")} />
          <SearchResultCard result={wikiResult("wiki/projects/live.md", "Live Project")} />
        </>
      ),
    });
    const wikiRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/wiki/$category/$slug",
      validateSearch: (search: Record<string, unknown>): { includeArchived?: 1 } => ({
        includeArchived: parseIncludeArchivedQuery(search.includeArchived) === true ? 1 : undefined,
      }),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([wikiRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });

    render(<RouterProvider router={router} />);

    const archivedLink = await screen.findByRole("link", { name: "Archived Project" });
    expect(archivedLink).toHaveAttribute("href", "/wiki/archive/old?includeArchived=1");
    expect(screen.getByRole("link", { name: "Live Project" }))
      .toHaveAttribute("href", "/wiki/projects/live");

    fireEvent.click(archivedLink);

    await waitFor(() => {
      expect(router.state.location.href).toBe("/wiki/archive/old?includeArchived=1");
    });
    expect(router.state.location.search).toEqual({ includeArchived: 1 });
  });
});

function wikiResult(path: string, title: string): SearchResult {
  return {
    path,
    title,
    snippet: `${title} snippet`,
    score: 0.9,
    source: "bm25",
    sources: [{ source: "bm25", rank: 1 }],
    provenance: {
      path,
      kind: "wiki",
      dominantSource: "bm25",
      signals: [{ source: "bm25", rank: 1 }],
      confidence: null,
      sourceFactCount: 0,
      derivedFromCount: 0,
      tier: "medium",
    },
    kind: "wiki",
  };
}
