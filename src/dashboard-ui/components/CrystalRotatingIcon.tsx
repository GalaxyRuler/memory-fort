import { Gem } from "lucide-react";
import { cn } from "../lib/cn.js";

export function CrystalRotatingIcon({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center justify-center", className)} aria-hidden>
      <Gem size={20} strokeWidth={1.25} className="animate-spin-slow text-entity-crystals" />
    </span>
  );
}
