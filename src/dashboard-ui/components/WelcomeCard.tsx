import { Link } from "@tanstack/react-router";
import { Compass, Plug, Search } from "lucide-react";
import { GlassPanel } from "./GlassPanel.js";

/**
 * True when the vault has little to no curated knowledge yet, i.e. a first-time
 * user who needs orientation rather than telemetry. Undefined counts (still
 * loading) return false so the welcome card never flashes before data arrives.
 */
export function isNewVault(counts: { wikiPages: number; rawObservations: number } | undefined): boolean {
  if (!counts) return false;
  return counts.wikiPages <= 2;
}

const STEPS = [
  {
    icon: Plug,
    to: "/settings",
    title: "Connect your tools",
    body: "Open Settings to pick which AI apps can save and read your memories.",
  },
  {
    icon: Search,
    to: "/search",
    title: "Search what's saved",
    body: "Anything your tools remember shows up here — try a search once you've used one.",
  },
] as const;

export function WelcomeCard() {
  return (
    <GlassPanel hasBrackets={true} className="border-primary/30 p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
          <Compass size={20} />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-text-primary">Welcome to Memory Fort</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Memory Fort remembers things across your AI tools, so they don&apos;t start from scratch every time.
            Here&apos;s how to get going.
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {STEPS.map((step) => {
          const Icon = step.icon;
          return (
            <Link
              key={step.to}
              to={step.to}
              className="group flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-2/60 p-4 transition-colors hover:border-primary/40 hover:bg-surface-2"
            >
              <span className="mt-0.5 flex-shrink-0 text-text-muted transition-colors group-hover:text-primary">
                <Icon size={18} strokeWidth={1.5} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text-primary group-hover:text-primary">
                  {step.title}
                </span>
                <span className="mt-0.5 block text-xs text-text-muted">{step.body}</span>
              </span>
            </Link>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-text-muted">
        This dashboard fills in on its own as your tools remember things. This card hides once your memory has a few
        pages.
      </p>
    </GlassPanel>
  );
}
