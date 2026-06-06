import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hasBrackets?: boolean;
}

export function Card({ children, className, hasBrackets, ...rest }: CardProps) {
  return (
    <div className={cn("relative rounded-lg border border-border-subtle/50 bg-surface p-4", className)} {...rest}>
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
