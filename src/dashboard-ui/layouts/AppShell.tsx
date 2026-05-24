import { Outlet } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { MobileBottomNav } from "./MobileBottomNav.js";
import { Sidebar } from "./Sidebar.js";
import { TopBar } from "./TopBar.js";

export function AppShell() {
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const mobileSidebarRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isMobileSidebarOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = getFocusableElements(mobileSidebarRef.current);
    const firstFocusable = focusable[0] ?? mobileSidebarRef.current;
    firstFocusable?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMobileSidebarOpen(false);
        return;
      }

      if (event.key !== "Tab") return;
      const focusableElements = getFocusableElements(mobileSidebarRef.current);
      if (focusableElements.length === 0) {
        event.preventDefault();
        mobileSidebarRef.current?.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isMobileSidebarOpen]);

  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      <Sidebar className="hidden md:flex" />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenMobileMenu={() => setIsMobileSidebarOpen(true)} />
        <main className="flex-1 overflow-auto pb-16 md:pb-0">
          <Outlet />
        </main>
      </div>
      <MobileBottomNav className="md:hidden" />
      {isMobileSidebarOpen ? (
        <div
          aria-label="Navigation menu"
          aria-modal="true"
          className="fixed inset-0 z-40 md:hidden"
          ref={mobileSidebarRef}
          role="dialog"
          tabIndex={-1}
        >
          <button
            type="button"
            aria-label="Close navigation menu"
            className="absolute inset-0 bg-background/70"
            onClick={() => setIsMobileSidebarOpen(false)}
            tabIndex={-1}
          />
          <div className="relative z-10 h-full w-[min(20rem,85vw)]">
            <Sidebar
              className="flex h-full w-full"
              label="Mobile primary sidebar"
              onNavigate={() => setIsMobileSidebarOpen(false)}
            />
            <button
              type="button"
              aria-label="Close navigation menu"
              className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
              onClick={() => setIsMobileSidebarOpen(false)}
            >
              <X size={18} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
}
