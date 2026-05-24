import { createFileRoute } from "@tanstack/react-router";
import { ConflictsPage } from "../components/ConflictsPage.js";

export const Route = createFileRoute("/conflicts")({
  component: ConflictsPage,
});
