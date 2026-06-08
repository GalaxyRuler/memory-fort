import { X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import type { GraphNode } from "../../hooks/useGraph.js";
import { usePageBody } from "../../hooks/usePageBody.js";
import { highlightSource, renderMarkdown } from "../../lib/markdown.js";
import { GlassPanel } from "../GlassPanel.js";

interface MemoryModalProps {
  graphNodes: GraphNode[];
  open: boolean;
  path: string;
  onClose: () => void;
  onSelectNode: (path: string) => void;
}

type MemoryTab = "rendered" | "source";

export function MemoryModal({ graphNodes, open, path, onClose, onSelectNode }: MemoryModalProps) {
  const [tab, setTab] = useState<MemoryTab>("rendered");
  const page = usePageBody(path, open);
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (open) {
      setTab("rendered");
    }
  }, [open, path]);

  useEffect(() => {
    if (!open) return undefined;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = getFocusableElements(modalRef.current);
    (focusable[0] ?? modalRef.current)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusableElements = getFocusableElements(modalRef.current);
      if (focusableElements.length === 0) {
        event.preventDefault();
        modalRef.current?.focus();
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
      previousFocus?.focus();
    };
  }, [onClose, open]);

  const renderedBody = useMemo(() => renderMarkdown(page.data?.body ?? ""), [page.data?.body]);
  const highlightedSource = useMemo(() => highlightSource(page.data?.body ?? ""), [page.data?.body]);
  const title = typeof page.data?.frontmatter.title === "string" ? page.data.frontmatter.title : leafName(path);

  if (!open) {
    return null;
  }

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const handleRenderedClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-wikilink]");
    const wikilink = target?.dataset.wikilink;
    if (!wikilink) {
      return;
    }

    const node = findGraphNodeForWikilink(wikilink, graphNodes);
    if (node) {
      onSelectNode(node.path);
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-night-950/75 p-4 backdrop-blur-md"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="max-h-[88vh] w-full max-w-4xl"
      >
        <GlassPanel hasBrackets className="flex max-h-[88vh] flex-col overflow-hidden">
          <header className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-[0.24em] text-white/45">{pathPrefix(path)}</p>
              <div id={titleId} className="truncate text-xl font-semibold text-white">{title}</div>
            </div>
            <button
              type="button"
              aria-label="Close memory"
              className="grid h-9 w-9 flex-none place-items-center rounded-md border border-white/10 bg-white/[0.04] text-white/70 transition hover:border-white/25 hover:text-white"
              onClick={onClose}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </header>

          <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3" role="tablist" aria-label="Memory body view">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "rendered"}
              className={tabClassName(tab === "rendered")}
              onClick={() => setTab("rendered")}
            >
              Rendered
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "source"}
              className={tabClassName(tab === "source")}
              onClick={() => setTab("source")}
            >
              Source
            </button>
          </div>

          <section className="min-h-0 flex-1 overflow-auto px-5 py-5">
            {page.isLoading ? (
              <p className="text-sm text-white/60">Loading memory...</p>
            ) : page.isError ? (
              <p className="text-sm text-red-200">Unable to load this memory.</p>
            ) : tab === "rendered" ? (
              <div
                className="galactic-markdown"
                onClick={handleRenderedClick}
                dangerouslySetInnerHTML={{ __html: renderedBody }}
              />
            ) : (
              <pre className="overflow-x-auto rounded-md border border-white/10 bg-black/35 p-4 text-sm leading-6 text-white/75">
                <code dangerouslySetInnerHTML={{ __html: highlightedSource }} />
              </pre>
            )}
          </section>
        </GlassPanel>
      </div>
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

function findGraphNodeForWikilink(wikilink: string, graphNodes: GraphNode[]): GraphNode | undefined {
  const target = wikilink.split("|")[0]!.split("#")[0]!.trim();
  const variants = new Set<string>([
    target,
    target.endsWith(".md") ? target : `${target}.md`,
    target.startsWith("wiki/") ? target : `wiki/${target}`,
    target.startsWith("wiki/") || target.endsWith(".md") ? target : `wiki/${target}.md`,
  ]);

  return graphNodes.find((node) => {
    const title = node.title.trim();
    return variants.has(node.path) || variants.has(title) || variants.has(leafName(node.path));
  });
}

function leafName(path: string): string {
  return path.split("/").at(-1)?.replace(/\.md$/i, "") ?? path;
}

function pathPrefix(path: string): string {
  const leaf = path.split("/").at(-1) ?? path;
  const prefix = path.slice(0, Math.max(0, path.length - leaf.length));
  return prefix.length > 0 ? prefix : "memory";
}

function tabClassName(active: boolean): string {
  return [
    "rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] transition",
    active
      ? "border border-cognitive-core/40 bg-cognitive-core/15 text-white"
      : "border border-white/10 bg-white/[0.03] text-white/55 hover:text-white",
  ].join(" ");
}
