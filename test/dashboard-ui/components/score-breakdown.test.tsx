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

  test("renders graph-spread with the shared label and color", () => {
    render(<ScoreBreakdown sources={[{ source: "graph-spread", rank: 2 }]} />);

    expect(screen.getByText("graph spread")).toBeInTheDocument();
    expect(screen.getByLabelText("graph spread: 100%")).toHaveClass("bg-entity-tools");
  });

  test("drops invalid ranks instead of rendering bogus widths", () => {
    render(
      <ScoreBreakdown
        sources={
          [
            { source: "", rank: 1 },
            { source: "bm25", rank: -1 },
            { source: "vector", rank: 0 },
            { source: "exact", rank: 1.5 },
            { source: "graph", rank: Number.MAX_SAFE_INTEGER + 1 },
            { source: "rerank", rank: 3 },
          ] as Array<{ source: string; rank: number }>
        }
      />,
    );

    const bar = screen.getByTestId("score-breakdown-bar");
    const segments = Array.from(bar.querySelectorAll("span"));

    expect(segments).toHaveLength(1);
    expect(segments[0]?.style.width).toBe("100%");
    expect(screen.getByText("rerank")).toBeInTheDocument();
    expect(screen.queryByText("BM25")).not.toBeInTheDocument();
    expect(screen.queryByText("embed")).not.toBeInTheDocument();
    expect(screen.queryByText("exact")).not.toBeInTheDocument();
    expect(screen.queryByText("graph")).not.toBeInTheDocument();
  });

  test("renders an empty neutral bar when no valid sources remain", () => {
    render(
      <ScoreBreakdown
        sources={
          [
            { source: "bm25", rank: Number.POSITIVE_INFINITY },
            { source: "vector", rank: Number.NaN },
            { source: "rerank", rank: 0 },
          ] as Array<{ source: string; rank: number }>
        }
      />,
    );

    const bar = screen.getByTestId("score-breakdown-bar");
    const segments = Array.from(bar.querySelectorAll("span"));

    expect(segments).toHaveLength(0);
    expect(screen.queryByText("BM25")).not.toBeInTheDocument();
    expect(screen.queryByText("embed")).not.toBeInTheDocument();
    expect(screen.queryByText("rerank")).not.toBeInTheDocument();
  });

  test("clamps and wraps unknown source labels in the legend", () => {
    const unknownSource = "untrusted source label with enough length to break compact layouts";

    render(<ScoreBreakdown sources={[{ source: unknownSource, rank: 1 }]} />);

    const label = screen.getByText("untrusted source label with enou...");
    expect(label).toBeInTheDocument();
    expect(label).toHaveClass("max-w-full");
    expect(label).toHaveClass("break-all");
    expect(screen.queryByText(unknownSource)).not.toBeInTheDocument();
    expect(screen.getByLabelText("untrusted source label with enou...: 100%")).toBeInTheDocument();
  });
});
