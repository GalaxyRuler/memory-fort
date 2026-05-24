import type { InputHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "rounded-md border border-border-subtle bg-surface px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:border-border-emphasis focus:outline-none",
        className,
      )}
      {...rest}
    />
  );
}
