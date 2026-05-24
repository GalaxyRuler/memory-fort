import { Link } from "@tanstack/react-router";
import { type RawIndexFile } from "../hooks/useRawIndex.js";
import {
  formatBytes,
  parseSessionIdFromFilename,
  parseSourceFromFilename,
  sourceColorClass,
} from "../lib/raw-helpers.js";
import { cn } from "../lib/cn.js";

export function SessionRow({ file, date }: { file: RawIndexFile; date: string }) {
  const source = parseSourceFromFilename(file.filename);
  const sessionId = parseSessionIdFromFilename(file.filename);
  const truncatedId = sessionId.length > 24 ? `${sessionId.slice(0, 8)}...${sessionId.slice(-12)}` : sessionId;

  return (
    <Link
      to="/raw/$date/$filename"
      params={{ date, filename: file.filename }}
      className="block hover:bg-surface-2 transition-colors border border-border-subtle rounded-md px-3 py-2 mb-1.5"
    >
      <div className="flex items-center gap-3">
        <span className={cn("w-2 h-2 rounded-full flex-shrink-0", sourceColorClass(source))} aria-hidden />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-mono text-text-primary truncate">{source}-{truncatedId}</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-text-muted font-mono flex-shrink-0">
          <span>{formatBytes(file.sizeBytes)}</span>
          <span>{new Date(file.mtime).toLocaleTimeString()}</span>
        </div>
      </div>
    </Link>
  );
}
