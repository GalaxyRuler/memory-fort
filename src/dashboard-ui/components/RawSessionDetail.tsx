import { useParams } from "@tanstack/react-router";
import { useRawSession } from "../hooks/useRawSession.js";
import {
  formatBytes,
  parseSourceFromFilename,
  sourceColorClass,
} from "../lib/raw-helpers.js";
import { cn } from "../lib/cn.js";
import { MarkdownBody } from "./MarkdownBody.js";
import { StatusPill } from "./StatusPill.js";

export function RawSessionDetail() {
  const { date, filename } = useParams({ from: "/raw/$date/$filename" });
  const session = useRawSession(date, filename);

  if (session.isLoading) return <div className="p-6 text-sm text-text-muted">Loading session...</div>;
  if (session.error || !session.data) {
    return <div className="p-6 text-sm text-status-red">Session not found: raw/{date}/{filename}</div>;
  }

  const data = session.data;
  const source = parseSourceFromFilename(data.filename);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <header className="mb-6 border-b border-border-subtle pb-4">
        <div className="flex items-center gap-2 mb-3">
          <span className={cn("w-2 h-2 rounded-full", sourceColorClass(source))} aria-hidden />
          <span className="text-xs uppercase tracking-wider text-text-muted">{source}</span>
          <StatusPill kind="active">raw</StatusPill>
        </div>
        <h1 className="text-xl font-mono font-medium tracking-tight mb-2 break-all">{data.sessionId}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted font-mono">
          <span>{data.date}</span>
          <span>{formatBytes(data.sizeBytes)}</span>
          <span>mtime {new Date(data.mtime).toLocaleString()}</span>
        </div>
      </header>

      <article>
        <MarkdownBody source={data.body} />
      </article>
    </div>
  );
}
