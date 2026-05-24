import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn.js";

export interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  className?: string;
}

export function GlassPanel({ children, className, ...rest }: GlassPanelProps) {
  return (
    <div className={cn("glass-blur rounded-lg p-4", className)} {...rest}>
      {children}
    </div>
  );
}
