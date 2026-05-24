import { Link, useLocation } from "@tanstack/react-router";
import { cn } from "../lib/cn.js";
import { MOBILE_NAV_ITEMS } from "../lib/nav-items.js";

export function MobileBottomNav({ className }: { className?: string }) {
  const location = useLocation();

  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-10 flex h-16 items-center justify-around border-t border-border-subtle bg-surface px-2",
        className,
      )}
      aria-label="Mobile navigation"
    >
      {MOBILE_NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive =
          location.pathname === item.to ||
          (item.to !== "/" && location.pathname.startsWith(item.to));

        return (
          <Link
            key={item.to}
            to={item.to}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-md px-3 py-2 transition-colors",
              isActive ? "text-text-primary" : "text-text-muted",
            )}
          >
            <Icon size={20} strokeWidth={1.5} />
            <span className="text-[10px]">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
