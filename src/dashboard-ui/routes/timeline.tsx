import { createFileRoute } from "@tanstack/react-router";
import { TimelinePage } from "../components/TimelinePage.js";

export const Route = createFileRoute("/timeline")({
  component: TimelinePage,
  validateSearch: (search): { zoom?: string } => ({
    zoom: typeof search.zoom === "string" ? search.zoom : undefined,
  }),
});
