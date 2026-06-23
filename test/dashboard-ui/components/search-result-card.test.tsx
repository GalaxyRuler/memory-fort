import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { SearchResultCard } from "../../../src/dashboard-ui/components/SearchResultCard.js";
import type { SearchResult } from "../../../src/dashboard-ui/hooks/useSearch.js";

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
  };
});

const RESULT: SearchResult = {
  path: "wiki/projects/provenance.md",
  title: "Provenance Signals",
  snippet: "A result with multiple retrieval signals.",
  score: 0.94,
  source: "rerank",
  sources: [
    { source: "bm25", rank: 1 },
    { source: "graph-spread", rank: 2 },
    { source: "rerank", rank: 3 },
  ],
  provenance: {
    path: "wiki/projects/provenance.md",
    kind: "wiki",
    dominantSource: "rerank",
    signals: [
      { source: "bm25", rank: 1 },
      { source: "graph-spread", rank: 2 },
      { source: "rerank", rank: 3 },
    ],
    confidence: null,
    sourceFactCount: 0,
    derivedFromCount: 0,
    tier: "medium",
  },
  kind: "crystal",
};

describe("SearchResultCard", () => {
  test("links wiki crystal results to the crystal wiki detail page", () => {
    const result: SearchResult = {
      ...RESULT,
      path: "wiki/crystals/retrieval.md",
      provenance: { ...RESULT.provenance, path: "wiki/crystals/retrieval.md" },
      title: "Retrieval Crystal",
    };

    render(<SearchResultCard result={result} />);

    expect(screen.getByRole("link", { name: "Retrieval Crystal" })).toHaveAttribute("href", "/wiki/crystals/retrieval");
  });

  test("falls back to the crystals page for top-level crystal result paths", () => {
    const result: SearchResult = {
      ...RESULT,
      path: "crystals/provenance-signals.md",
      provenance: { ...RESULT.provenance, path: "crystals/provenance-signals.md" },
    };

    render(<SearchResultCard result={result} />);

    expect(screen.getByRole("link", { name: "Provenance Signals" })).toHaveAttribute("href", "/crystals");
  });

  test("preserves raw markdown filenames in result links", () => {
    const result: SearchResult = {
      ...RESULT,
      kind: "raw",
      path: "raw/2026-05-24/codex-session.md",
      provenance: {
        ...RESULT.provenance,
        kind: "raw",
        path: "raw/2026-05-24/codex-session.md",
      },
      title: "Codex Session",
    };

    render(<SearchResultCard result={result} />);

    expect(screen.getByRole("link", { name: "Codex Session" })).toHaveAttribute(
      "href",
      "/raw/2026-05-24/codex-session.md",
    );
  });

  test("renders a compact provenance receipt for search signals", () => {
    render(<SearchResultCard result={RESULT} />);

    const summary = screen.getByText("Why this matched");
    expect(summary).toBeVisible();

    fireEvent.click(summary);

    expect(screen.getByText("BM25 rank 1")).toBeVisible();
    expect(screen.getByText("graph spread rank 2")).toBeVisible();
    expect(screen.getByText("rerank rank 3")).toBeVisible();
  });

  test("renders without a provenance receipt when signals are empty", () => {
    const result: SearchResult = {
      ...RESULT,
      provenance: { ...RESULT.provenance, signals: [] },
    };

    render(<SearchResultCard result={result} />);

    expect(screen.getByText("Provenance Signals")).toBeVisible();
    expect(screen.queryByText("Why this matched")).not.toBeInTheDocument();
  });

  test("renders duplicate provenance ranks without duplicate key warnings", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const result: SearchResult = {
      ...RESULT,
      provenance: {
        ...RESULT.provenance,
        signals: [
          { source: "bm25", rank: 1 },
          { source: "bm25", rank: 1 },
        ],
      },
    };

    render(<SearchResultCard result={result} />);
    fireEvent.click(screen.getByText("Why this matched"));

    expect(screen.getAllByText("BM25 rank 1")).toHaveLength(2);
    expect(
      consoleError.mock.calls.some((call) =>
        call.some((argument) => String(argument).includes("Encountered two children with the same key")),
      ),
    ).toBe(false);
    consoleError.mockRestore();
  });

  test("keeps long unknown source labels visible and overflow safe", () => {
    const longSource = "unknown-source-with-a-very-long-label-that-should-stay-readable";
    const result: SearchResult = {
      ...RESULT,
      provenance: {
        ...RESULT.provenance,
        signals: [{ source: longSource, rank: 4 }],
      },
    };

    render(<SearchResultCard result={result} />);
    fireEvent.click(screen.getByText("Why this matched"));

    const receipt = screen.getByText("unknown-source-with-a-very-long-... rank 4");
    expect(receipt).toBeVisible();
    expect(receipt).toHaveClass("max-w-full");
    expect(receipt).toHaveClass("break-all");
    expect(screen.queryByText(`${longSource} rank 4`)).not.toBeInTheDocument();
  });

  test("uses sanitized source labels in the compact score column", () => {
    const longSource = "unknown-source-with-a-very-long-label-that-should-not-render-raw\nwith-control";
    const result: SearchResult = {
      ...RESULT,
      source: longSource,
      sources: [],
      provenance: {
        ...RESULT.provenance,
        dominantSource: longSource,
        signals: [{ source: "bm25", rank: 1 }],
      },
    };

    render(<SearchResultCard result={result} />);

    const scoreColumn = screen.getByText("Score").closest("div");
    expect(scoreColumn).not.toBeNull();
    expect(within(scoreColumn as HTMLElement).getByText("unknown-source-with-a-very-long-...")).toBeVisible();
    expect(within(scoreColumn as HTMLElement).queryByText("unknown-source-with-a-very-long-label-that-should-not-render-raw with-control")).not.toBeInTheDocument();
  });

  test("drops invalid provenance signals before rendering receipt chips", () => {
    const result = {
      ...RESULT,
      provenance: {
        ...RESULT.provenance,
        signals: [
          { source: "", rank: 1 },
          { source: "bm25", rank: "garbage" },
          { source: "vector", rank: -1 },
          { source: "exact", rank: 0 },
          { source: "graph", rank: 1.5 },
          { source: "metadata", rank: Number.MAX_SAFE_INTEGER + 1 },
          { source: "rerank", rank: "2" },
        ],
      },
    } as unknown as SearchResult;

    render(<SearchResultCard result={result} />);
    fireEvent.click(screen.getByText("Why this matched"));

    expect(screen.getByText("rerank rank 2")).toBeVisible();
    expect(screen.queryByText(" rank 1")).not.toBeInTheDocument();
    expect(screen.queryByText("BM25 rank garbage")).not.toBeInTheDocument();
    expect(screen.queryByText("embed rank -1")).not.toBeInTheDocument();
    expect(screen.queryByText("exact rank 0")).not.toBeInTheDocument();
    expect(screen.queryByText("graph rank 1.5")).not.toBeInTheDocument();
    expect(screen.queryByText(`meta rank ${Number.MAX_SAFE_INTEGER + 1}`)).not.toBeInTheDocument();
  });

  test("renders without a provenance receipt when all signals are invalid", () => {
    const result = {
      ...RESULT,
      provenance: {
        ...RESULT.provenance,
        signals: [
          { source: " ", rank: 1 },
          { source: "bm25", rank: "1.5" },
          { source: "vector", rank: Number.POSITIVE_INFINITY },
        ],
      },
    } as unknown as SearchResult;

    render(<SearchResultCard result={result} />);

    expect(screen.getByText("Provenance Signals")).toBeVisible();
    expect(screen.queryByText("Why this matched")).not.toBeInTheDocument();
  });
});
