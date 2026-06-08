import { useId, useMemo } from "react";
import { type TimelineResponse } from "../hooks/useTimeline.js";
import { timestampToX } from "../lib/time-helpers.js";

const LANE_HEIGHT = 50;
const LANE_GAP = 4;
const VELOCITY_HEIGHT = 60;
const CHART_PADDING_X = 16;
const LABEL_WIDTH = 100;

const LANE_COLORS: Record<string, string> = {
  "claude-code": "#5b8bff",
  codex: "#8b5fff",
  antigravity: "#34d399",
  manual: "#52525b",
  compile: "#fbbf24",
  lint: "#f472b6",
  sync: "#22d3ee",
};

export function TimelineChart({ data, width = 800 }: { data: TimelineResponse; width?: number }) {
  const descId = useId();
  const chartWidth = width - LABEL_WIDTH - CHART_PADDING_X * 2;
  const chartHeight = data.lanes.length * (LANE_HEIGHT + LANE_GAP);

  const velocityPath = useMemo(() => {
    if (data.velocity.length === 0) return "";
    const maxCount = Math.max(...data.velocity.map((bucket) => bucket.count), 1);
    return data.velocity
      .map((bucket) => {
        const x = LABEL_WIDTH + CHART_PADDING_X + timestampToX(bucket.bucket, data.from, data.to, chartWidth);
        const y = VELOCITY_HEIGHT - (bucket.count / maxCount) * VELOCITY_HEIGHT;
        return `${x},${y}`;
      })
      .join(" ");
  }, [data, chartWidth]);

  const totalHeight = VELOCITY_HEIGHT + 16 + chartHeight + 24;

  const laneNames = data.lanes.map((l) => l.lane).join(", ");

  return (
    <svg
      viewBox={`0 0 ${width} ${totalHeight}`}
      className="w-full h-auto"
      role="img"
      aria-label="Event velocity chart showing activity over time"
      aria-describedby={descId}
    >
      <desc id={descId}>
        {`Timeline chart with ${data.lanes.length} lanes: ${laneNames}. Each lane shows events as labelled dots on a time axis from ${data.from} to ${data.to}.`}
      </desc>
      <g>
        <text
          x={LABEL_WIDTH + CHART_PADDING_X}
          y={12}
          className="fill-text-muted text-[10px] font-mono uppercase tracking-wider"
        >
          EVENT VELOCITY
        </text>
        <defs>
          <linearGradient id="velocity-gradient" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#8b5fff" />
            <stop offset="100%" stopColor="#5b8bff" />
          </linearGradient>
        </defs>
        {velocityPath && (
          <polyline
            data-testid="velocity-line"
            points={velocityPath}
            fill="none"
            stroke="url(#velocity-gradient)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
      </g>

      <g transform={`translate(0, ${VELOCITY_HEIGHT + 16})`}>
        {data.lanes.map((lane, index) => {
          const yCenter = index * (LANE_HEIGHT + LANE_GAP) + LANE_HEIGHT / 2;
          const color = LANE_COLORS[lane.lane] ?? "#52525b";
          return (
            <g key={lane.lane}>
              <text
                x={CHART_PADDING_X}
                y={yCenter}
                dy="0.35em"
                className="fill-text-muted text-[10px] font-mono uppercase tracking-wider"
              >
                {lane.lane}
              </text>
              <line
                data-testid="lane-track"
                x1={LABEL_WIDTH + CHART_PADDING_X}
                y1={yCenter}
                x2={LABEL_WIDTH + CHART_PADDING_X + chartWidth}
                y2={yCenter}
                stroke="rgba(255,255,255,0.04)"
                strokeWidth={1}
              />
              {lane.events.map((event, eventIndex) => {
                const x = LABEL_WIDTH + CHART_PADDING_X + timestampToX(event.timestamp, data.from, data.to, chartWidth);
                return (
                  <circle
                    data-testid="timeline-event"
                    key={`${event.timestamp}-${eventIndex}`}
                    cx={x}
                    cy={yCenter}
                    r={3}
                    fill={event.entity_color ?? color}
                    opacity={0.85}
                  >
                    <title>{`${lane.lane} - ${event.timestamp}\n${event.summary}`}</title>
                  </circle>
                );
              })}
            </g>
          );
        })}
      </g>

      <g transform={`translate(0, ${VELOCITY_HEIGHT + 16 + chartHeight + 4})`}>
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const x = LABEL_WIDTH + CHART_PADDING_X + fraction * chartWidth;
          const fromMs = new Date(data.from).getTime();
          const toMs = new Date(data.to).getTime();
          const label = new Date(fromMs + fraction * (toMs - fromMs)).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          return (
            <g key={fraction}>
              <line x1={x} x2={x} y1={0} y2={4} stroke="rgba(255,255,255,0.12)" />
              <text x={x} y={16} textAnchor="middle" className="fill-text-muted text-[10px] font-mono">
                {label}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
