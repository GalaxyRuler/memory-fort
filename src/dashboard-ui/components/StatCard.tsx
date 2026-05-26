import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { Card } from "./Card.js";
import { Sparkline } from "./Sparkline.js";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  sparkline?: number[];
  sparklineColor?: string;
  footer?: ReactNode;
  borderColor?: string;
  glowClass?: string;
}

export function StatCard({
  label,
  value,
  sparkline,
  sparklineColor,
  footer,
  borderColor,
  glowClass,
}: StatCardProps) {
  return (
    <Card
      hasBrackets={true}
      className={cn(
        "flex flex-col justify-between overflow-hidden",
        borderColor,
        glowClass,
      )}
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="break-words text-xs uppercase tracking-wider text-text-muted">{label}</p>
        {sparkline && (
          <Sparkline
            data={sparkline}
            strokeColor={sparklineColor ?? "rgba(6, 182, 212, 0.7)"}
            className="opacity-80"
          />
        )}
      </div>
      <p className="break-words font-mono text-3xl font-extrabold tracking-tight text-text-primary">
        {value}
      </p>
      {footer && <div className="mt-2 break-words text-[11px] font-mono text-text-muted">{footer}</div>}
    </Card>
  );
}
