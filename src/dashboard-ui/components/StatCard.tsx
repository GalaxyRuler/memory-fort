import type { ReactNode } from "react";
import { Card } from "./Card.js";
import { Sparkline } from "./Sparkline.js";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  sparkline?: number[];
  sparklineColor?: string;
  footer?: ReactNode;
}

export function StatCard({ label, value, sparkline, sparklineColor, footer }: StatCardProps) {
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="break-words text-xs uppercase tracking-wider text-text-muted">{label}</p>
        {sparkline && (
          <Sparkline
            data={sparkline}
            strokeColor={sparklineColor ?? "rgb(91 139 255 / 0.7)"}
            className="opacity-80"
          />
        )}
      </div>
      <p className="break-words text-2xl font-semibold tracking-tight">{value}</p>
      {footer && <p className="mt-1 break-words text-xs text-text-muted">{footer}</p>}
    </Card>
  );
}
