import { type HTMLAttributes } from "react";
import { useReducedMotion } from "../lib/reduced-motion.js";
import { cn } from "../lib/cn.js";

export type SkeletonVariant = "line" | "block" | "card";

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SkeletonVariant;
}

const VARIANT_CLASS: Record<SkeletonVariant, string> = {
  line: "h-3 w-full",
  block: "h-24 w-full",
  card: "h-32 w-full rounded-lg border border-border-subtle",
};

export function Skeleton({ className, variant = "line", ...rest }: SkeletonProps) {
  const reducedMotion = useReducedMotion();

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md bg-surface-2",
        !reducedMotion && "animate-shimmer bg-gradient-to-r from-surface via-surface-2 to-surface bg-[length:200%_100%]",
        VARIANT_CLASS[variant],
        className,
      )}
      data-variant={variant}
      {...rest}
    />
  );
}
