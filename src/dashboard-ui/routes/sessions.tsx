import { createFileRoute } from "@tanstack/react-router";
import { SessionsPage } from "../components/SessionsPage.js";

export const Route = createFileRoute("/sessions")({
  component: SessionsPage,
  validateSearch: (search): { source?: string; per?: string } => ({
    source: typeof search.source === "string" ? search.source : undefined,
    per: typeof search.per === "string" ? search.per : undefined,
  }),
});
