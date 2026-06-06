import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CommandPalette } from "../../../src/dashboard-ui/components/CommandPalette.js";
import { CommandPaletteProvider } from "../../../src/dashboard-ui/hooks/useCommandPalette.js";

const routerMock = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => routerMock.navigate,
  };
});

function makeSearchResponse(source = "rerank") {
  return {
    query: "voyage",
    results: [
      {
        path: "wiki/projects/foo.md",
        title: "Foo Project",
        snippet: "Foo project snippet",
        score: 0.91,
        source,
        sources: [{ source, rank: 1 }],
        provenance: {
          path: "wiki/projects/foo.md",
          kind: "wiki",
          dominantSource: source,
          signals: [{ source, rank: 1 }],
        },
        kind: "wiki",
      },
    ],
    warnings: [],
    timings: {
      corpusMs: 1,
      embedQueryMs: 1,
      bm25Ms: 1,
      vectorMs: 1,
      rerankMs: 1,
      totalMs: 37,
    },
    degraded: false,
    hyde: { used: false, reason: "not-triggered" },
    corpusErrorCount: 0,
  };
}

function renderPalette(children?: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CommandPaletteProvider>
        {children}
        <CommandPalette />
      </CommandPaletteProvider>
    </QueryClientProvider>,
  );
}

function openWithShortcut() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
}

describe("CommandPalette", () => {
  beforeEach(() => {
    routerMock.navigate.mockReset();
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test("command shortcut opens the palette", () => {
    renderPalette();

    openWithShortcut();

    expect(screen.getByRole("combobox", { name: "Search memory" })).toBeInTheDocument();
  });

  test("Escape closes the palette", async () => {
    renderPalette();
    openWithShortcut();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("combobox", { name: "Search memory" })).not.toBeInTheDocument();
    });
  });

  test("typing fires a debounced search", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify(makeSearchResponse()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPalette();
    openWithShortcut();

    fireEvent.change(screen.getByRole("combobox", { name: "Search memory" }), {
      target: { value: "voyage" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("q=voyage");
    expect(String(fetchMock.mock.calls[0][0])).toContain("noRerank=true");
  });

  test("does not render inert sort controls", () => {
    renderPalette();
    openWithShortcut();

    expect(screen.queryByText("Sort:")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "recent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "confidence" })).not.toBeInTheDocument();
  });

  test("labels palette search responses as fast", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify(makeSearchResponse()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPalette();
    openWithShortcut();

    fireEvent.change(screen.getByRole("combobox", { name: "Search memory" }), {
      target: { value: "voyage" },
    });

    expect(await screen.findByText(/37ms .* fast/)).toBeInTheDocument();
  });

  test("summarizes graph-spread search sources", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify(makeSearchResponse("graph-spread")), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPalette();
    openWithShortcut();

    fireEvent.change(screen.getByRole("combobox", { name: "Search memory" }), {
      target: { value: "voyage" },
    });

    expect(await screen.findByText(/1 results .* graph spread/)).toBeInTheDocument();
  });

  test("selecting a result navigates and closes the palette", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify(makeSearchResponse()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPalette();
    openWithShortcut();

    fireEvent.change(screen.getByRole("combobox", { name: "Search memory" }), {
      target: { value: "voyage" },
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText("Foo Project")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Foo Project"));

    expect(routerMock.navigate).toHaveBeenCalledWith({
      to: "/wiki/$category/$slug",
      params: { category: "projects", slug: "foo" },
    });
    await waitFor(() => {
      expect(screen.queryByRole("combobox", { name: "Search memory" })).not.toBeInTheDocument();
    });
  });
});
