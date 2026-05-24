import { createFileRoute } from "@tanstack/react-router";
import { MaintenancePage } from "../components/MaintenancePage.js";

export const Route = createFileRoute("/maintenance")({
  component: MaintenancePage,
});
