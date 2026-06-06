import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
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
});
