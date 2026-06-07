import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { TimelineChart } from "../../../src/dashboard-ui/components/TimelineChart.js";
import type { TimelineResponse } from "../../../src/dashboard-ui/hooks/useTimeline.js";

function timeline(overrides: Partial<TimelineResponse> = {}): TimelineResponse {
  return {
    from: "2026-05-24T00:00:00.000Z",
    to: "2026-05-25T00:00:00.000Z",
    zoom: "1D",
    lanes: [
      {
        lane: "git",
        events: [
          { timestamp: "2026-05-24T02:00:00.000Z", summary: "git 1" },
          { timestamp: "2026-05-24T03:00:00.000Z", summary: "git 2" },
          { timestamp: "2026-05-24T04:00:00.000Z", summary: "git 3" },
        ],
      },
      {
        lane: "sync",
        events: [
          { timestamp: "2026-05-24T05:00:00.000Z", summary: "sync 1" },
          { timestamp: "2026-05-24T06:00:00.000Z", summary: "sync 2" },
          { timestamp: "2026-05-24T07:00:00.000Z", summary: "sync 3" },
        ],
      },
    ],
    velocity: [
      { bucket: "2026-05-24T00:00:00.000Z", count: 1 },
      { bucket: "2026-05-24T12:00:00.000Z", count: 6 },
      { bucket: "2026-05-25T00:00:00.000Z", count: 2 },
    ],
    ...overrides,
  };
}

describe("TimelineChart", () => {
  test("renders one lane track per lane", () => {
    const data = timeline({
      lanes: [
        { lane: "git", events: [] },
        { lane: "sync", events: [] },
        { lane: "compile", events: [] },
      ],
    });

    const { container } = render(<TimelineChart data={data} />);

    expect(screen.getByRole("img", { name: "Event velocity chart showing activity over time" })).toBeInTheDocument();
    expect(container.querySelectorAll('line[data-testid="lane-track"]')).toHaveLength(3);
  });

  test("renders an event circle for every event", () => {
    const { container } = render(<TimelineChart data={timeline()} />);

    expect(container.querySelectorAll('circle[data-testid="timeline-event"]')).toHaveLength(6);
  });

  test("renders a velocity polyline when velocity has data", () => {
    const { container } = render(<TimelineChart data={timeline()} />);
    const polyline = container.querySelector('polyline[data-testid="velocity-line"]');

    expect(polyline).not.toBeNull();
    expect(polyline?.getAttribute("points")).not.toBe("");
  });

  test("renders no velocity polyline when velocity is empty", () => {
    const { container } = render(<TimelineChart data={timeline({ velocity: [] })} />);

    expect(container.querySelector('polyline[data-testid="velocity-line"]')).toBeNull();
  });
});
