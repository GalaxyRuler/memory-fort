import { createFileRoute } from "@tanstack/react-router";
import { RawBrowsePage } from "../components/RawBrowsePage.js";

export const Route = createFileRoute("/raw")({
  component: RawBrowsePage,
  validateSearch: (search): { source?: string } => ({
    source: typeof search.source === "string" ? search.source : undefined,
  }),
});
