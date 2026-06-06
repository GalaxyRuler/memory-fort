import { type HTMLAttributes } from "react";
import { Link } from "@tanstack/react-router";
import { type RawIndexFile } from "../hooks/useRawIndex.js";
import {
  formatBytes,
  parseSessionIdFromFilename,
  parseSourceFromFilename,
  sourceColorClass,
} from "../lib/raw-helpers.js";
import { cn } from "../lib/cn.js";

export function SessionRow({
  file,
  date,
  keyboardProps,
}: {
  file: RawIndexFile;
  date: string;
  keyboardProps?: HTMLAttributes<HTMLLIElement>;
}) {
  const source = parseSourceFromFilename(file.filename);
  const sessionId = parseSessionIdFromFilename(file.filename);
  const truncatedId = sessionId.length > 24 ? `${sessionId.slice(0, 8)}...${sessionId.slice(-12)}` : sessionId;
  const rowClassName =
    "mb-1.5 rounded-md border border-border-subtle transition-colors hover:bg-surface-2 focus-within:bg-surface-2 focus-within:ring-1 focus-within:ring-primary/60";
  const content = (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      <span className={cn("hidden h-2 w-2 flex-shrink-0 rounded-full md:block", sourceColorClass(source))} aria-hidden />
      <div className="flex-1 min-w-0">
        <p className="break-all font-mono text-sm text-text-primary md:truncate">{source}-{truncatedId}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-text-muted md:flex-shrink-0">
        <span>{formatBytes(file.sizeBytes)}</span>
        <span>{new Date(file.mtime).toLocaleTimeString()}</span>
      </div>
    </div>
  );

  if (keyboardProps) {
    const { className, ...itemProps } = keyboardProps;
    const linkProps = itemProps as HTMLAttributes<HTMLAnchorElement>;
    return (
      <li className={cn(rowClassName, className)}>
        <Link
          to="/raw/$date/$filename"
          params={{ date, filename: file.filename }}
          className="block rounded-md px-3 py-3 focus:outline-none md:py-2"
          {...linkProps}
        >
          {content}
        </Link>
      </li>
    );
  }

  return (
    <Link
      to="/raw/$date/$filename"
      params={{ date, filename: file.filename }}
      className={cn("block px-3 py-3 md:py-2", rowClassName)}
    >
      {content}
    </Link>
  );
}
