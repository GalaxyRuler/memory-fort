import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export type TimelineZoom = "1H" | "1D" | "1W" | "1M" | "1Y";

export interface TimelineEvent {
  timestamp: string;
  summary: string;
  entity_color?: string;
  source?: string;
}

export interface TimelineLane {
  lane: string;
  events: TimelineEvent[];
}

export interface TimelineVelocityBucket {
  bucket: string;
  count: number;
}

export interface TimelineResponse {
  from: string;
  to: string;
  zoom: TimelineZoom;
  lanes: TimelineLane[];
  velocity: TimelineVelocityBucket[];
}

export interface UseTimelineOptions {
  from?: string;
  to?: string;
  zoom?: TimelineZoom;
}

export function useTimeline({ from, to, zoom = "1D" }: UseTimelineOptions = {}) {
  return useQuery({
    queryKey: ["timeline", from, to, zoom],
    queryFn: () => apiGet<TimelineResponse>("/timeline", { from, to, zoom }),
    staleTime: 30_000,
  });
}
