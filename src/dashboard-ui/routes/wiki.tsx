import { createFileRoute } from "@tanstack/react-router";
import { WikiBrowsePage } from "../components/WikiBrowsePage.js";

export const Route = createFileRoute("/wiki")({
  component: WikiBrowsePage,
  validateSearch: (search): { category?: string } => ({
    category: typeof search.category === "string" ? search.category : undefined,
  }),
});
