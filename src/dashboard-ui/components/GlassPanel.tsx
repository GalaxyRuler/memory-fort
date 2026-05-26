import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn.js";

export interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  className?: string;
  hasBrackets?: boolean;
}

export function GlassPanel({ children, className, hasBrackets, ...rest }: GlassPanelProps) {
  return (
    <div className={cn("relative glass-blur rounded-lg p-4", className)} {...rest}>
      {hasBrackets && (
        <>
          <span className="bracket-tl" aria-hidden="true" />
          <span className="bracket-br" aria-hidden="true" />
        </>
      )}
      {children}
    </div>
  );
}
