import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn.js";

export interface BottomSheetProps {
  children: ReactNode;
  isOpen: boolean;
  onClose: () => void;
  title: string;
  className?: string;
  contentClassName?: string;
}

export function BottomSheet({
  children,
  className,
  contentClassName,
  isOpen,
  onClose,
  title,
}: BottomSheetProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusable = getFocusableElements(dialogRef.current);
    const firstFocusable = focusable[0] ?? dialogRef.current;
    firstFocusable?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusableElements = getFocusableElements(dialogRef.current);
      if (focusableElements.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className={cn("fixed inset-0 z-40 flex items-end justify-center", className)}>
      <button
        type="button"
        aria-hidden="true"
        className="absolute inset-0 bg-background/70"
        data-testid="bottom-sheet-backdrop"
        onClick={onClose}
        tabIndex={-1}
      />
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="glass-blur relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-xl shadow-2xl"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex min-h-14 items-center justify-between gap-3 border-b border-border-subtle px-4 py-2">
          <h2 id={titleId} className="min-w-0 break-words text-base font-semibold text-text-primary">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close bottom sheet"
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
            onClick={onClose}
          >
            <X size={18} strokeWidth={1.5} />
          </button>
        </header>
        <div className={cn("overflow-y-auto p-4", contentClassName)}>{children}</div>
      </section>
    </div>
  );
}

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
}
