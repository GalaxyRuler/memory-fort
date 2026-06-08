import { act, fireEvent, render, screen } from "@testing-library/react";
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
      to,
    }: {
      children: React.ReactNode;
      className?: string;
      to: string;
    }) => (
      <a className={className} href={to}>
        {children}
      </a>
    ),
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
    kind: "wiki",
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

  test("gives the search input an accessible name", () => {
    render(<SearchPage />);

    expect(screen.getByRole("textbox", { name: "Search memory" })).toBeInTheDocument();
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
});
