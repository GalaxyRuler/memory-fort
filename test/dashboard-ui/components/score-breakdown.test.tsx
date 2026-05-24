import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ScoreBreakdown } from "../../../src/dashboard-ui/components/ScoreBreakdown.js";

const SOURCES = [
  { source: "bm25", rank: 1 },
  { source: "vector", rank: 5 },
  { source: "rerank", rank: 20 },
];

describe("ScoreBreakdown", () => {
  test("renders segments proportional to source contribution", () => {
    render(<ScoreBreakdown sources={SOURCES} />);

    const bar = screen.getByTestId("score-breakdown-bar");
    const segments = Array.from(bar.querySelectorAll("span"));
    const totalWidth = segments.reduce((sum, segment) => {
      return sum + Number.parseFloat(segment.style.width);
    }, 0);

    expect(segments).toHaveLength(3);
    expect(totalWidth).toBeGreaterThan(99.9);
    expect(totalWidth).toBeLessThan(100.1);
  });

  test("renders legend with source labels", () => {
    render(<ScoreBreakdown sources={SOURCES} />);

    expect(screen.getByText("BM25")).toBeInTheDocument();
    expect(screen.getByText("embed")).toBeInTheDocument();
    expect(screen.getByText("rerank")).toBeInTheDocument();
  });
});
