import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "../components/SettingsPage.js";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});
