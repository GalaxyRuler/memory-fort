import { Link, useLocation } from "@tanstack/react-router";
import { StatusPill } from "../components/StatusPill.js";
import { cn } from "../lib/cn.js";
import { NAV_ITEMS } from "../lib/nav-items.js";

export function Sidebar({
  className,
  label = "Primary sidebar",
  onNavigate,
}: {
  className?: string;
  label?: string;
  onNavigate?: () => void;
}) {
  const location = useLocation();

  return (
    <aside
      aria-label={label}
      className={cn(
        "w-[220px] flex-shrink-0 flex-col gap-1 border-r border-border-subtle bg-surface p-3",
        className,
      )}
    >
      <div className="px-3 py-4">
        <h1 className="text-lg font-semibold tracking-tight">memory</h1>
        <p className="text-xs text-text-muted">v0.4.0-dev</p>
      </div>
      <nav className="flex flex-col gap-0.5" aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive =
            location.pathname === item.to ||
            (item.to !== "/" && location.pathname.startsWith(item.to));

          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              className={cn(
                "relative flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors md:min-h-0 md:py-1.5",
                isActive
                  ? "bg-surface-2 text-text-primary"
                  : "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
              )}
            >
              {isActive && (
                <span
                  className="gradient-accent absolute bottom-1 left-0 top-1 w-[2px] rounded-r"
                  aria-hidden
                />
              )}
              <Icon size={16} strokeWidth={1.5} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto px-2">
        <StatusPill kind="synced">synced 8s ago</StatusPill>
      </div>
    </aside>
  );
}
