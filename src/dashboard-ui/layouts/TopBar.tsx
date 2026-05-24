import { useLocation } from "@tanstack/react-router";
import { Menu, Search } from "lucide-react";
import { useOptionalCommandPaletteContext } from "../hooks/useCommandPalette.js";
import { NAV_ITEMS } from "../lib/nav-items.js";

export function TopBar({ onOpenMobileMenu }: { onOpenMobileMenu?: () => void }) {
  const commandPalette = useOptionalCommandPaletteContext();
  const location = useLocation();
  const segments = location.pathname.split("/").filter(Boolean);
  const matchedNav = NAV_ITEMS.find(
    (item) =>
      location.pathname === item.to ||
      (item.to !== "/" && location.pathname.startsWith(item.to)),
  );
  const breadcrumbText = matchedNav?.label ?? "Overview";
  const mobileBreadcrumb = segments.length > 0
    ? decodeURIComponent(segments[segments.length - 1] ?? breadcrumbText)
    : breadcrumbText;

  return (
    <header className="flex h-14 items-center justify-between gap-2 border-b border-border-subtle bg-surface/40 px-3 backdrop-blur md:h-12 md:px-4">
      <div className="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
        <button
          type="button"
          aria-label="Open navigation menu"
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary md:hidden"
          onClick={onOpenMobileMenu}
        >
          <Menu size={20} strokeWidth={1.5} />
        </button>
        <div
          className="hidden min-w-0 items-center gap-2 text-sm text-text-secondary md:flex"
          data-testid="desktop-breadcrumb"
        >
          <span>{breadcrumbText}</span>
          {segments.slice(1).map((segment) => (
            <span key={segment} className="flex min-w-0 items-center gap-2">
              <span className="text-text-muted">›</span>
              <span className="min-w-0 break-words">{decodeURIComponent(segment)}</span>
            </span>
          ))}
        </div>
        <span
          className="min-w-0 truncate text-sm font-medium text-text-primary md:hidden"
          data-testid="mobile-breadcrumb"
        >
          {mobileBreadcrumb}
        </span>
      </div>
      <button
        type="button"
        onClick={() => commandPalette?.openPalette()}
        className="flex h-11 min-w-11 flex-shrink-0 items-center justify-center gap-2 rounded-md border border-border-subtle bg-surface px-3 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary md:h-9 md:min-w-0 md:px-2.5"
        aria-label="Open command palette"
      >
        <Search size={12} strokeWidth={1.5} />
        <span className="hidden sm:inline">Search...</span>
        <kbd className="hidden font-mono text-text-muted sm:inline">⌘K</kbd>
      </button>
    </header>
  );
}
