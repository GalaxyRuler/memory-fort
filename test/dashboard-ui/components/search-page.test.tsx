import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SearchPage } from "../../../src/dashboard-ui/components/SearchPage.js";
import type { SearchIndexStatus, SearchResult } from "../../../src/dashboard-ui/hooks/useSearch.js";

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
      confidence: null,
      sourceFactCount: 0,
      derivedFromCount: 0,
      tier: "medium",
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
      confidence: null,
      sourceFactCount: 0,
      derivedFromCount: 0,
      tier: "medium",
    },
    kind: "crystal",
  };
}

function makeIndexStatus(overrides: Partial<SearchIndexStatus> = {}): SearchIndexStatus {
  return {
    enabled: true,
    dbPath: "C:\\Memory\\index.db",
    sizeBytes: 4096,
    schemaVersion: "3",
    chunkCount: 12,
    filesSkipped: 0,
    skippedFiles: [],
    lastCompleteReconcile: "2026-07-04T00:00:00.000Z",
    currentState: "idle",
    lastError: null,
    ready: true,
    ...overrides,
  };
}

function mockZeroResultSearch({
  degraded = false,
  warnings = [],
  index = makeIndexStatus(),
}: {
  degraded?: boolean;
  warnings?: string[];
  index?: SearchIndexStatus;
} = {}): void {
  routerState.search = { q: "needle" };
  searchHook.useSearch.mockReturnValue({
    data: {
      results: [],
      timings: { totalMs: 8 },
      degraded,
      warnings,
      index,
    },
    isLoading: false,
  });
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

  test("shows indexing diagnostics instead of a false no-results state", () => {
    routerState.search = { q: "needle" };
    searchHook.useSearch.mockReturnValue({
      data: {
        results: [],
        timings: { totalMs: 8 },
        degraded: true,
        warnings: ["indexing"],
        index: {
          enabled: true,
          dbPath: "C:\\Memory\\index.db",
          sizeBytes: 4096,
          schemaVersion: "3",
          chunkCount: 12,
          filesSkipped: 2,
          skippedFiles: [],
          lastCompleteReconcile: null,
          currentState: "building",
          lastError: null,
          ready: false,
        },
      },
      isLoading: false,
    });

    render(<SearchPage />);

    expect(screen.getByText("Indexing in progress")).toBeInTheDocument();
    expect(screen.getByText("C:\\Memory\\index.db")).toBeInTheDocument();
    expect(screen.getByText("4.0 KiB")).toBeInTheDocument();
    expect(screen.getByText("building")).toBeInTheDocument();
    expect(screen.getByText("2 skipped")).toBeInTheDocument();
    expect(screen.getByText(/MEMORY_INDEX_SEARCH=0/)).toBeInTheDocument();
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
  });

  test("shows degraded diagnostics when index search reports an error", () => {
    routerState.search = { q: "needle" };
    searchHook.useSearch.mockReturnValue({
      data: {
        results: [],
        timings: { totalMs: 8 },
        degraded: true,
        warnings: ["search process unavailable: spawn failed"],
        index: {
          enabled: true,
          dbPath: "C:\\Memory\\index.db",
          sizeBytes: 0,
          schemaVersion: null,
          chunkCount: 0,
          filesSkipped: 0,
          skippedFiles: [],
          lastCompleteReconcile: null,
          currentState: "repairing",
          lastError: "database disk image is malformed",
          ready: false,
        },
      },
      isLoading: false,
    });

    render(<SearchPage />);

    expect(screen.getByText("Search index degraded")).toBeInTheDocument();
    expect(screen.getByText("database disk image is malformed")).toBeInTheDocument();
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
  });

  test.each([
    [
      "building",
      makeIndexStatus({
        ready: false,
        currentState: "building",
        lastCompleteReconcile: null,
      }),
      false,
      ["indexing"],
      "Indexing in progress",
    ],
    [
      "repairing",
      makeIndexStatus({
        ready: false,
        currentState: "repairing",
        lastError: "database disk image is malformed",
      }),
      false,
      [],
      "Search index degraded",
    ],
    [
      "error-after-success",
      makeIndexStatus({
        ready: true,
        currentState: "error",
        lastError: "last reconcile failed after a completed build",
      }),
      false,
      [],
      "Search index degraded",
    ],
    [
      "backfilling",
      makeIndexStatus({
        ready: true,
        currentState: "backfilling",
      }),
      false,
      [],
      "Indexing in progress",
    ],
    [
      "degraded response",
      makeIndexStatus(),
      true,
      [],
      "Search index degraded",
    ],
    [
      "warning response",
      makeIndexStatus(),
      false,
      ["cursor-invalid"],
      "Search index degraded",
    ],
  ])("shows the index notice instead of a false empty state for %s", (_label, index, degraded, warnings, title) => {
    mockZeroResultSearch({ degraded, warnings, index });

    render(<SearchPage />);

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByLabelText("Search index status")).toBeInTheDocument();
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
  });

  test("shows no-results only when the index is positively healthy", () => {
    mockZeroResultSearch({
      index: makeIndexStatus({
        ready: true,
        currentState: "idle",
        lastError: null,
      }),
    });

    render(<SearchPage />);

    expect(screen.getByText('No results for "needle".')).toBeInTheDocument();
    expect(screen.queryByLabelText("Search index status")).not.toBeInTheDocument();
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

  test("j navigation from a focused result title link moves to the next managed result", () => {
    routerState.search = { q: "voyage" };
    searchHook.useSearch.mockReturnValue({
      data: {
        results: [
          makeResult(),
          {
            ...makeResult(),
            path: "wiki/projects/bar.md",
            title: "Bar Project",
            provenance: {
              ...makeResult().provenance,
              path: "wiki/projects/bar.md",
            },
          },
        ],
        timings: { totalMs: 42 },
        degraded: false,
        warnings: [],
      },
      isLoading: false,
    });

    render(<SearchPage />);

    const firstTitleLink = screen.getByRole("link", { name: "Foo Project" });
    const nextResult = screen.getByText("Bar Project").closest("[role='listitem']");

    firstTitleLink.focus();
    fireEvent.keyDown(firstTitleLink, { key: "j" });

    expect(nextResult).toHaveFocus();
    expect(nextResult).toHaveAttribute("data-focused", "true");
  });
});
