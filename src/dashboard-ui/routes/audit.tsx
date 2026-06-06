import { createFileRoute } from "@tanstack/react-router";
import { AuditPage } from "../components/AuditPage.js";

export const Route = createFileRoute("/audit")({
  component: AuditPage,
  validateSearch: (search): { source?: string; level?: string } => ({
    source: typeof search.source === "string" ? search.source : undefined,
    level: typeof search.level === "string" ? search.level : undefined,
  }),
});
