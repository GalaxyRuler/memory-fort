import type { ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-primary text-background hover:opacity-90",
  secondary: "border border-border-emphasis text-text-primary hover:bg-surface-2",
  ghost: "text-text-secondary hover:bg-surface hover:text-text-primary",
};

export function Button({ variant = "secondary", className, children, ...rest }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
