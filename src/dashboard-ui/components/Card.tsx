import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export function Card({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-lg border border-border-subtle bg-surface p-4", className)} {...rest}>
      {children}
    </div>
  );
}
