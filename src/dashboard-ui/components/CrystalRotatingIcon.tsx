import { Gem } from "lucide-react";
import { cn } from "../lib/cn.js";
import { useReducedMotion } from "../lib/reduced-motion.js";

export function CrystalRotatingIcon({ className }: { className?: string }) {
  const reducedMotion = useReducedMotion();

  return (
    <span className={cn("inline-flex items-center justify-center", className)} aria-hidden>
      <Gem size={20} strokeWidth={1.25} className={cn(!reducedMotion && "animate-spin-slow", "text-entity-crystals")} />
    </span>
  );
}
