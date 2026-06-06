import { type ComponentType, type ReactNode } from "react";
import { type LucideProps } from "lucide-react";
import { cn } from "../lib/cn.js";

export interface EmptyStateProps {
  icon: ComponentType<LucideProps>;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ action, className, description, icon: Icon, title }: EmptyStateProps) {
  return (
    <div className={cn("rounded-lg border border-border-subtle bg-surface p-6 text-center", className)}>
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-surface-2 text-text-muted">
        <Icon data-testid="empty-state-icon" size={18} strokeWidth={1.5} />
      </div>
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-text-secondary">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
