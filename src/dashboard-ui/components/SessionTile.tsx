import { type HTMLAttributes } from "react";
import { Link } from "@tanstack/react-router";
import { Cpu, Rocket, Terminal, User } from "lucide-react";
import { type RawIndexFile } from "../hooks/useRawIndex.js";
import { cn } from "../lib/cn.js";
import {
  formatBytes,
  parseSessionIdFromFilename,
  parseSourceFromFilename,
  type RawSource,
} from "../lib/raw-helpers.js";
import { decodeUuidV7Time } from "../lib/uuidv7.js";

const SOURCE_ICON = {
  "claude-code": Terminal,
  codex: Cpu,
  antigravity: Rocket,
  manual: User,
  unknown: Terminal,
} as const;

const SOURCE_ICON_BG: Record<RawSource, string> = {
  "claude-code": "bg-entity-projects/15",
  codex: "bg-entity-decisions/15",
  antigravity: "bg-entity-tools/15",
  manual: "bg-text-muted/15",
  unknown: "bg-text-muted/15",
};

const SOURCE_ICON_TEXT: Record<RawSource, string> = {
  "claude-code": "text-entity-projects",
  codex: "text-entity-decisions",
  antigravity: "text-entity-tools",
  manual: "text-text-muted",
  unknown: "text-text-muted",
};

export function SessionTile({
  file,
  date,
  keyboardProps,
}: {
  file: RawIndexFile;
  date: string;
  keyboardProps?: HTMLAttributes<HTMLAnchorElement>;
}) {
  const source = parseSourceFromFilename(file.filename);
  const sessionId = parseSessionIdFromFilename(file.filename);
  const captureTime = decodeUuidV7Time(sessionId);
  const Icon = SOURCE_ICON[source];
  const truncatedId = sessionId.length > 18 ? `${sessionId.slice(0, 8)}...${sessionId.slice(-6)}` : sessionId;

  return (
    <Link
      to="/raw/$date/$filename"
      params={{ date, filename: file.filename }}
      className="block rounded-lg border border-border-subtle bg-surface p-4 transition-all hover:border-border-emphasis hover:bg-surface-2 data-[focused=true]:border-primary/60 data-[focused=true]:bg-surface-2 data-[focused=true]:ring-1 data-[focused=true]:ring-primary/60"
      {...keyboardProps}
    >
      <div className="mb-3 flex items-start justify-between">
        <div className={cn("flex h-9 w-9 items-center justify-center rounded-md", SOURCE_ICON_BG[source])}>
          <Icon size={18} strokeWidth={1.5} className={SOURCE_ICON_TEXT[source]} />
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{source}</span>
      </div>
      <p className="mb-1 break-all font-mono text-sm text-text-primary md:truncate">{truncatedId}</p>
      <p className="break-words font-mono text-xs text-text-muted">{date}</p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3 font-mono text-xs text-text-muted">
        <span>{formatBytes(file.sizeBytes)}</span>
        {captureTime ? (
          <span>{captureTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        ) : null}
      </div>
    </Link>
  );
}
