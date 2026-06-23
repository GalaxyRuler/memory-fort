import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CommandPalette } from "../../../src/dashboard-ui/components/CommandPalette.js";
import type { SearchResult } from "../../../src/dashboard-ui/hooks/useSearch.js";

const routerMock = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

const commandPaletteMock = vi.hoisted(() => ({
  close: vi.fn(),
  setOpen: vi.fn(),
}));

const searchMock = vi.hoisted(() => ({
  result: null as SearchResult | null,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => routerMock.navigate,
  };
});

vi.mock("../../../src/dashboard-ui/hooks/useCommandPalette.js", () => ({
  useCommandPaletteContext: () => ({
    open: true,
    setOpen: commandPaletteMock.setOpen,
    close: commandPaletteMock.close,
  }),
}));

vi.mock("../../../src/dashboard-ui/hooks/useSearch.js", () => ({
  useSearch: () => ({
    data: searchMock.result
      ? {
          query: "fixture",
          results: [searchMock.result],
          warnings: [],
          timings: {
            corpusMs: 1,
            embedQueryMs: 1,
            bm25Ms: 1,
            vectorMs: 1,
            rerankMs: 1,
            totalMs: 5,
          },
          degraded: false,
          hyde: { used: false, reason: "not-triggered" },
          corpusErrorCount: 0,
        }
      : undefined,
    isLoading: false,
  }),
}));

function makeResult(overrides: Partial<SearchResult>): SearchResult {
  const result = {
    path: "wiki/projects/foo.md",
    title: "Foo Project",
    snippet: "Foo project snippet",
    score: 0.91,
    source: "rerank",
    sources: [{ source: "rerank", rank: 1 }],
    provenance: {
      path: "wiki/projects/foo.md",
      kind: "wiki" as const,
      dominantSource: "rerank",
      signals: [{ source: "rerank", rank: 1 }],
      confidence: null,
      sourceFactCount: 0,
      derivedFromCount: 0,
      tier: "medium" as const,
    },
    kind: "wiki",
    ...overrides,
  };
  return {
    ...result,
    kind: result.kind as SearchResult["kind"],
    provenance: overrides.provenance ?? {
      path: result.path,
      kind: result.kind as SearchResult["kind"],
      dominantSource: result.source,
      signals: result.sources,
      confidence: null,
      sourceFactCount: 0,
      derivedFromCount: 0,
      tier: "medium" as const,
    },
  };
}

describe("CommandPalette navigation", () => {
  beforeEach(() => {
    routerMock.navigate.mockReset();
    commandPaletteMock.close.mockReset();
    commandPaletteMock.setOpen.mockReset();
    searchMock.result = null;
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
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
  });

  test.each([
    [
      "wiki",
      makeResult({
        kind: "wiki",
        path: "wiki/projects/foo.md",
        title: "Foo Project",
      }),
      {
        to: "/wiki/$category/$slug",
        params: { category: "projects", slug: "foo" },
      },
    ],
    [
      "raw",
      makeResult({
        kind: "raw",
        path: "raw/2026-05-24/codex-session.md",
        title: "Codex Session",
      }),
      {
        to: "/raw/$date/$filename",
        params: { date: "2026-05-24", filename: "codex-session.md" },
      },
    ],
    [
      "crystal",
      makeResult({
        kind: "crystal",
        path: "crystals/retrieval.md",
        title: "Retrieval Crystal",
      }),
      { to: "/crystals" },
    ],
  ])("selecting a %s result closes and navigates", async (_label, result, target) => {
    searchMock.result = result;

    render(<CommandPalette />);

    fireEvent.click(await screen.findByText(result.title));

    expect(commandPaletteMock.close).toHaveBeenCalledTimes(1);
    expect(routerMock.navigate).toHaveBeenCalledWith(target);
  });
});
