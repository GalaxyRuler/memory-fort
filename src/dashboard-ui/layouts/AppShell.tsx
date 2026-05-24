import { Outlet } from "@tanstack/react-router";
import { MobileBottomNav } from "./MobileBottomNav.js";
import { Sidebar } from "./Sidebar.js";
import { TopBar } from "./TopBar.js";

export function AppShell() {
  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      <Sidebar className="hidden md:flex" />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex-1 overflow-auto pb-16 md:pb-0">
          <Outlet />
        </main>
      </div>
      <MobileBottomNav className="md:hidden" />
    </div>
  );
}
