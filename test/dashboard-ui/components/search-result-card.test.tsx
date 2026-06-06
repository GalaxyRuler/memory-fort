import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { SearchResultCard } from "../../../src/dashboard-ui/components/SearchResultCard.js";
import type { SearchResult } from "../../../src/dashboard-ui/hooks/useSearch.js";

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
  },
  kind: "crystal",
};

describe("SearchResultCard", () => {
  test("renders a compact provenance receipt for search signals", () => {
    render(<SearchResultCard result={RESULT} />);

    const summary = screen.getByText("Why this matched");
    expect(summary).toBeVisible();

    fireEvent.click(summary);

    expect(screen.getByText("BM25 rank 1")).toBeVisible();
    expect(screen.getByText("graph spread rank 2")).toBeVisible();
    expect(screen.getByText("rerank rank 3")).toBeVisible();
  });

  test("renders without a provenance receipt when provenance is missing", () => {
    const result = { ...RESULT, provenance: undefined } as unknown as SearchResult;

    render(<SearchResultCard result={result} />);

    expect(screen.getByText("Provenance Signals")).toBeVisible();
    expect(screen.queryByText("Why this matched")).not.toBeInTheDocument();
  });

  test("renders without a provenance receipt when signals are missing", () => {
    const result = {
      ...RESULT,
      provenance: { ...RESULT.provenance, signals: undefined },
    } as unknown as SearchResult;

    render(<SearchResultCard result={result} />);

    expect(screen.getByText("Provenance Signals")).toBeVisible();
    expect(screen.queryByText("Why this matched")).not.toBeInTheDocument();
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

    const receipt = screen.getByText(`${longSource} rank 4`);
    expect(receipt).toBeVisible();
    expect(receipt).toHaveClass("max-w-full");
    expect(receipt).toHaveClass("break-all");
  });
});
