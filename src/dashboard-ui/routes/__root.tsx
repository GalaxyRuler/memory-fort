import { createRootRoute } from "@tanstack/react-router";
import { CommandPalette } from "../components/CommandPalette.js";
import { CommandPaletteProvider } from "../hooks/useCommandPalette.js";
import { AppShell } from "../layouts/AppShell.js";

export const Route = createRootRoute({
  component: Root,
});

function Root() {
  return (
    <CommandPaletteProvider>
      <AppShell />
      <CommandPalette />
    </CommandPaletteProvider>
  );
}
