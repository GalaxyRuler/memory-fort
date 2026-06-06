import { createFileRoute } from "@tanstack/react-router";
import { RawBrowsePage } from "../components/RawBrowsePage.js";

export const Route = createFileRoute("/raw/")({
  component: RawBrowsePage,
  validateSearch: (search): { source?: string; per?: string } => ({
    source: typeof search.source === "string" ? search.source : undefined,
    per: typeof search.per === "string" ? search.per : undefined,
  }),
});
