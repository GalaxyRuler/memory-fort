import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SearchPage } from "../../../src/dashboard-ui/components/SearchPage.js";
import type { SearchResult } from "../../../src/dashboard-ui/hooks/useSearch.js";

const routerState = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));

const searchHook = vi.hoisted(() => ({
  useSearch: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      children,
      className,
      params,
      to,
    }: {
      children: React.ReactNode;
      className?: string;
      params?: Record<string, string>;
      to: string;
    }) => {
      const href = params
        ? to
            .replace("$category", params.category ?? "")
            .replace("$slug", params.slug ?? "")
            .replace("$date", params.date ?? "")
            .replace("$filename", params.filename ?? "")
        : to;
      return (
        <a className={className} href={href}>
          {children}
        </a>
      );
    },
    useNavigate: () => routerState.navigate,
    useSearch: () => routerState.search,
  };
});

vi.mock("../../../src/dashboard-ui/hooks/useSearch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useSearch.js")>();
  return {
    ...actual,
    useSearch: searchHook.useSearch,
  };
});

function makeResult(): SearchResult {
  return {
    path: "wiki/projects/foo.md",
    title: "Foo Project",
    snippet: "A useful project result.",
    score: 0.92,
    source: "rerank",
    sources: [
      { source: "bm25", rank: 1 },
      { source: "rerank", rank: 1 },
    ],
    provenance: {
      path: "wiki/projects/foo.md",
      kind: "wiki",
      dominantSource: "rerank",
      signals: [
        { source: "bm25", rank: 1 },
        { source: "rerank", rank: 1 },
      ],
    },
    kind: "wiki",
  };
}

function makeCrystalResult(): SearchResult {
  return {
    ...makeResult(),
    path: "wiki/crystals/retrieval.md",
    title: "Usage Patterns",
    snippet: "A durable crystal result.",
    provenance: {
      path: "wiki/crystals/retrieval.md",
      kind: "crystal",
      dominantSource: "rerank",
      signals: [
        { source: "bm25", rank: 1 },
        { source: "rerank", rank: 1 },
      ],
    },
    kind: "crystal",
  };
}

describe("SearchPage", () => {
  beforeEach(() => {
    routerState.search = {};
    routerState.navigate.mockReset();
    searchHook.useSearch.mockReset();
    searchHook.useSearch.mockReturnValue({
      data: undefined,
      isLoading: false,
    });
  });

  test("renders empty state when no query is present", () => {
    render(<SearchPage />);

    expect(screen.getByText("Type a query to begin searching memory.")).toBeInTheDocument();
  });

  test("renders results after typing a debounced query", async () => {
    vi.useFakeTimers();
    searchHook.useSearch.mockImplementation(({ query }) => ({
      data:
        query === "voyage"
          ? {
              results: [makeResult()],
              timings: { totalMs: 42 },
              degraded: false,
              warnings: [],
            }
          : undefined,
      isLoading: false,
    }));
    render(<SearchPage />);

    fireEvent.change(screen.getByPlaceholderText("Search memory..."), {
      target: { value: "voyage" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(screen.getByText("Foo Project")).toBeInTheDocument();
    vi.useRealTimers();
  });

  test("renders search results as a list instead of a listbox", () => {
    routerState.search = { q: "voyage" };
    searchHook.useSearch.mockReturnValue({
      data: {
        results: [makeResult()],
        timings: { totalMs: 42 },
        degraded: false,
        warnings: [],
      },
      isLoading: false,
    });

    render(<SearchPage />);

    const list = screen.getByRole("list", { name: "Search results" });
    const item = screen.getByRole("listitem");

    expect(list).toBeInTheDocument();
    expect(within(item).getByText("Foo Project")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  test("filter change updates scope in the URL state", () => {
    routerState.search = { q: "voyage", scope: "wiki" };
    render(<SearchPage />);

    fireEvent.click(screen.getByRole("button", { name: /All/ }));

    const call = routerState.navigate.mock.calls.at(-1)?.[0];
    expect(call.replace).toBe(true);
    expect(call.search({ q: "voyage", scope: "wiki" })).toMatchObject({
      q: "voyage",
      scope: "all",
    });
  });

  test("renders crystal results as links to the crystal wiki detail page", () => {
    routerState.search = { q: "crystal" };
    searchHook.useSearch.mockReturnValue({
      data: {
        results: [makeCrystalResult()],
        timings: { totalMs: 42 },
        degraded: false,
        warnings: [],
      },
      isLoading: false,
    });

    render(<SearchPage />);

    expect(screen.getByRole("link", { name: "Usage Patterns" })).toHaveAttribute("href", "/wiki/crystals/retrieval");
  });

  test("activating a focused crystal result navigates to the crystal wiki detail page", () => {
    routerState.search = { q: "crystal" };
    searchHook.useSearch.mockReturnValue({
      data: {
        results: [makeCrystalResult()],
        timings: { totalMs: 42 },
        degraded: false,
        warnings: [],
      },
      isLoading: false,
    });

    render(<SearchPage />);

    const list = screen.getByRole("list", { name: "Search results" });
    list.focus();
    fireEvent.keyDown(list, { key: "Enter" });

    expect(routerState.navigate).toHaveBeenCalledWith({
      to: "/wiki/$category/$slug",
      params: { category: "crystals", slug: "retrieval" },
    });
  });
});
