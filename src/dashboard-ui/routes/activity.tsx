import { createFileRoute } from "@tanstack/react-router";
import { ActivityFeedPage } from "../components/ActivityFeedPage.js";

export const Route = createFileRoute("/activity")({
  component: ActivityFeedPage,
  validateSearch: (search): { source?: string; level?: string } => ({
    source: typeof search.source === "string" ? search.source : undefined,
    level: typeof search.level === "string" ? search.level : undefined,
  }),
});
