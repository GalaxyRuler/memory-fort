import { createRootRoute } from "@tanstack/react-router";
import { AppShell } from "../layouts/AppShell.js";

export const Route = createRootRoute({
  component: AppShell,
});
