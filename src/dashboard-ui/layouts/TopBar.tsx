import { useLocation } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { NAV_ITEMS } from "../lib/nav-items.js";

export function TopBar() {
  const location = useLocation();
  const segments = location.pathname.split("/").filter(Boolean);
  const matchedNav = NAV_ITEMS.find(
    (item) =>
      location.pathname === item.to ||
      (item.to !== "/" && location.pathname.startsWith(item.to)),
  );
  const breadcrumbText = matchedNav?.label ?? "Overview";

  return (
    <header className="flex h-12 items-center justify-between border-b border-border-subtle bg-surface/40 px-4 backdrop-blur">
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <span>{breadcrumbText}</span>
        {segments.slice(1).map((segment) => (
          <span key={segment} className="flex items-center gap-2">
            <span className="text-text-muted">›</span>
            <span>{decodeURIComponent(segment)}</span>
          </span>
        ))}
      </div>
      <button
        type="button"
        className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
        aria-label="Open command palette"
      >
        <Search size={12} strokeWidth={1.5} />
        <span>Search...</span>
        <kbd className="font-mono text-text-muted">⌘K</kbd>
      </button>
    </header>
  );
}
