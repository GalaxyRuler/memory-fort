import { createFileRoute, Link } from "@tanstack/react-router";
import { GlassPanel } from "../components/GlassPanel.js";
import { EmptyState } from "../components/EmptyState.js";
import { GraphHealthPanel } from "../components/GraphHealthPanel.js";
import { HealthBadge } from "../components/HealthBadge.js";
import { NeedsAttention } from "../components/NeedsAttention.js";
import { WelcomeCard, isNewVault } from "../components/WelcomeCard.js";
import { StatCard } from "../components/StatCard.js";
import { useActivity } from "../hooks/useActivity.js";
import { useStatus } from "../hooks/useStatus.js";
import { useWikiIndex } from "../hooks/useWikiIndex.js";
import { useGraph } from "../hooks/useGraph.js";
import { relativeTime } from "../lib/time-helpers.js";
import { ENTITY_COLORS } from "../lib/graph-colors.js";
import { Activity, ShieldAlert, Cpu, Compass, Search } from "lucide-react";
import { cn } from "../lib/cn.js";

const SOURCE_BADGE_CLASS: Record<string, string> = {
  git: "bg-entity-references",
  sync: "bg-entity-projects",
  compile: "bg-entity-lessons",
};

export const Route = createFileRoute("/")({
  component: OverviewScreen,
});

function getCategoryRGB(cat: string): string {
  switch (cat) {
    case "projects": return "74, 222, 128";
    case "decisions": return "244, 114, 182";
    case "lessons": return "167, 139, 250";
    case "references": return "96, 165, 250";
    case "tools": return "251, 191, 36";
    case "crystals": return "34, 211, 238";
    default: return "6, 182, 212";
  }
}

function OverviewScreen() {
  const status = useStatus();
  const activity = useActivity(10);
  const wiki = useWikiIndex();
  const graph = useGraph("wiki");

  const counts = status.data?.counts;
  const newVault = isNewVault(counts);

  // 1. Pages metric and breakdown
  const byCategory = wiki.data?.byCategory ?? {};
  const categoryBreakdown = Object.entries(byCategory)
    .map(([cat, list]) => `${cat.slice(0, 4)}:${list.length}`)
    .join(" ");

  // 2. Edges metric and breakdown
  const totalEdges = graph.data?.edges?.length ?? 0;
  const wikilinksCount = graph.data?.edges?.filter((e) => e.kind === "wikilink")?.length ?? 0;
  const relationsCount = graph.data?.edges?.filter((e) => e.kind === "relation")?.length ?? 0;
  const edgeBreakdown = `wiki:${wikilinksCount} rel:${relationsCount}`;

  // 3. Compile summary
  const lastCompileTime = status.data?.lastCompile?.timestamp
    ? relativeTime(status.data.lastCompile.timestamp)
    : "never";
  const compileLog = status.data?.lastCompile?.line ?? "";
  const matchPages = compileLog.match(/(\d+)\s+pages/i) || compileLog.match(/processed\s+(\d+)/i);
  const pagesProcessed = matchPages ? `${matchPages[1]} pgs` : "";
  const matchDuration = compileLog.match(/in\s+([\d.]+s)/i) || compileLog.match(/took\s+([\d.]+s)/i);
  const duration = matchDuration ? matchDuration[1] : "";
  const compileFooter = [pagesProcessed, duration].filter(Boolean).join(" | ") || "curator idle";

  // 4. Confidence statistics
  const wikiNodes = (graph.data?.nodes ?? []).filter((n) => n.kind === "wiki");
  const highConf = wikiNodes.filter((n) => (n.confidence ?? 0) >= 0.8).length;
  const medConf = wikiNodes.filter((n) => (n.confidence ?? 0) >= 0.5 && (n.confidence ?? 0) < 0.8).length;
  const lowConf = wikiNodes.filter((n) => (n.confidence ?? 0) < 0.5).length;
  const totalWikiNodes = wikiNodes.length || 1;
  const highPct = Math.round((highConf / totalWikiNodes) * 100);
  const medPct = Math.round((medConf / totalWikiNodes) * 100);
  const lowPct = Math.round((lowConf / totalWikiNodes) * 100);

  // 5. Top 5 most connected nodes
  const topNodes = [...wikiNodes]
    .sort((a, b) => b.inboundCount - a.inboundCount)
    .slice(0, 5);

  // 6. Recently updated pages list
  const wikiEntries = Object.values(wiki.data?.byCategory ?? {}).flat();
  const recentlyUpdated = [...wikiEntries]
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, 6)
    .map((entry) => {
      // /api/wiki returns relPath without the "wiki/" prefix; /api/graph uses the
      // full vault-relative path. Prepend so the lookup actually matches.
      const graphPath = `wiki/${entry.relPath}`;
      const node = graph.data?.nodes.find((n) => n.path === graphPath);
      return {
        ...entry,
        confidence: node?.confidence ?? null,
        inboundCount: node?.inboundCount ?? null,
        outboundCount: node?.outboundCount ?? null,
      };
    });

  const wikiSpark = Array(5).fill(counts?.wikiPages ?? 0) as number[];
  const rawSpark = Array(5).fill(counts?.rawObservations ?? 0) as number[];

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border-subtle/30 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Overview</h1>
          <p className="text-sm text-text-secondary">System telemetry and cognitive memory dashboard.</p>
        </div>
        <div className="flex items-center gap-3 font-mono text-xs text-text-muted">
          <span>vault: {status.data?.vaultRoot || "-"}</span>
          <span>•</span>
          <span>head: {status.data?.repoHead?.shortSha || "untracked"}</span>
        </div>
      </header>

      {newVault ? <WelcomeCard /> : null}
      <HealthBadge newVault={newVault} />
      <GraphHealthPanel />

      {/* Top Row: 4 Metric Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total Pages"
          value={counts?.wikiPages ?? "-"}
          sparkline={wikiSpark}
          sparklineColor="rgba(74, 222, 128, 0.7)"
          borderColor="border-t-2 border-t-[#4ade80]"
          glowClass="glow-subtle"
          footer={categoryBreakdown || "calculating..."}
        />
        <StatCard
          label="Total Edges"
          value={totalEdges}
          borderColor="border-t-2 border-t-[#8b5cf6]"
          glowClass="glow-subtle"
          footer={edgeBreakdown || "connecting..."}
        />
        <StatCard
          label="Search Readiness"
          value="ONLINE"
          borderColor="border-t-2 border-t-[#22d3ee]"
          glowClass="glow-pulse"
          footer={
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-[#10b981] motion-safe:animate-pulse" />
                Vector
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-[#10b981]" />
                BM25
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-[#10b981]" />
                Graph
              </span>
            </div>
          }
        />
        <StatCard
          label="Last Compile"
          value={lastCompileTime}
          borderColor="border-t-2 border-t-[#fbbf24]"
          glowClass="glow-subtle"
          footer={compileFooter}
        />
      </div>

      {/* Middle Row: Recent Activity & Quick Stats */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Recent Activity (60%) */}
        <div className="lg:col-span-7 flex flex-col">
          <GlassPanel hasBrackets={true} className="flex-1 flex flex-col p-5">
            <h2 className="mb-4 flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-text-muted">
              <Activity size={14} className="text-cyan-400" />
              Recent Activity Feed
            </h2>
            {activity.isLoading ? (
              <div className="text-sm text-text-muted py-6">Loading activity log...</div>
            ) : null}
            {activity.data?.events.length === 0 ? (
              <EmptyState
                icon={Activity}
                title="No recent activity yet"
                description="Compile, sync, or capture a session to populate this feed."
                className="border-0 bg-transparent py-6"
                action={
                  <Link
                    to="/activity"
                    className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary md:min-h-8"
                  >
                    Open activity
                  </Link>
                }
              />
            ) : null}
            <div
              tabIndex={0}
              aria-label="Recent activity feed"
              className="flex-1 overflow-y-auto max-h-[340px] pr-2 space-y-3 scrollbar-thin scrollbar-thumb-surface-4"
            >
              {activity.data?.events.slice(0, 10).map((event, index) => (
                <div
                  key={`${event.timestamp}-${index}`}
                  className="flex items-center justify-between gap-4 p-2 rounded border border-border-subtle/20 bg-surface-2/40 hover:bg-surface-2/70 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] uppercase font-mono font-bold text-background ${SOURCE_BADGE_CLASS[event.source] ?? "bg-amber-400"}`}
                    >
                      {event.source}
                    </span>
                    <span className="text-sm text-text-primary truncate">{event.summary}</span>
                  </div>
                  <span className="text-[10px] font-mono text-text-muted flex-shrink-0">
                    {relativeTime(event.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          </GlassPanel>
        </div>

        {/* Quick Stats (40%) */}
        <div className="lg:col-span-5 flex flex-col gap-4">
          <GlassPanel hasBrackets={true} className="flex-1 p-5 space-y-4">
            <h2 className="flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-text-muted">
              <Compass size={14} className="text-violet-400" />
              Quick Stats
            </h2>

            {/* Confidence distribution chart */}
            <div className="space-y-2">
              <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">Confidence Distribution</p>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-status-green">High (&ge;0.8)</span>
                  <span className="text-text-secondary">{highConf} ({highPct}%)</span>
                </div>
                <div className="h-1.5 w-full bg-surface-3 rounded-full overflow-hidden">
                  <div className="h-full bg-status-green rounded-full" style={{ width: `${highPct}%` }} />
                </div>

                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-status-amber">Medium (0.5-0.8)</span>
                  <span className="text-text-secondary">{medConf} ({medPct}%)</span>
                </div>
                <div className="h-1.5 w-full bg-surface-3 rounded-full overflow-hidden">
                  <div className="h-full bg-status-amber rounded-full" style={{ width: `${medPct}%` }} />
                </div>

                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-status-red">Low (&lt;0.5)</span>
                  <span className="text-text-secondary">{lowConf} ({lowPct}%)</span>
                </div>
                <div className="h-1.5 w-full bg-surface-3 rounded-full overflow-hidden">
                  <div className="h-full bg-status-red rounded-full" style={{ width: `${lowPct}%` }} />
                </div>
              </div>
            </div>

            {/* Top 5 connected nodes */}
            <div className="space-y-1.5 pt-2 border-t border-border-subtle/30">
              <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">Top 5 Connected Nodes</p>
              <div className="space-y-1 font-mono text-xs">
                {topNodes.map((node) => (
                  <div key={node.path} className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 truncate">
                      <span
                        className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: ENTITY_COLORS[node.type] || "#cebdff" }}
                      />
                      <span className="text-text-primary truncate">{node.title}</span>
                    </div>
                    <span className="text-text-muted flex-shrink-0">in:{node.inboundCount} out:{node.outboundCount}</span>
                  </div>
                ))}
              </div>
            </div>
          </GlassPanel>

          {/* Needs Attention Rail */}
          <NeedsAttention status={status.data} />
        </div>
      </div>

      {/* Bottom Row: Recently Updated Pages horizontal scroll */}
      <GlassPanel hasBrackets={true} className="p-5">
        <h2 className="mb-4 flex items-center gap-2 text-xs uppercase tracking-wider font-semibold text-text-muted">
          <Cpu size={14} className="text-amber-400" />
          Recently Updated Pages
        </h2>
        {recentlyUpdated.length === 0 ? (
          <div className="text-sm text-text-muted py-6">No curated wiki pages found.</div>
        ) : null}
        <div className="flex gap-4 overflow-x-auto pb-3 pr-2 scrollbar-thin scrollbar-thumb-surface-4">
          {recentlyUpdated.map((page) => (
            <Link
              key={page.relPath}
              to="/wiki/$category/$slug"
              params={{ category: page.category, slug: page.slug }}
              className="group relative block w-[280px] flex-shrink-0 cursor-pointer rounded-lg border border-border-subtle/40 bg-surface-2 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:bg-surface-3"
              style={{
                boxShadow: `0 0 16px rgba(${getCategoryRGB(page.category)}, 0.02)`,
              }}
            >
              {/* Subtle top border stripe using category color */}
              <span
                className="absolute inset-x-0 top-0 h-[2px] rounded-t-lg opacity-60 transition-opacity group-hover:opacity-100"
                style={{ backgroundColor: ENTITY_COLORS[page.category] }}
              />
              <div className="mb-2 flex items-center justify-between gap-2">
                <span
                  className="text-[10px] font-mono font-bold uppercase tracking-wider"
                  style={{ color: ENTITY_COLORS[page.category] }}
                >
                  {page.category}
                </span>
                <span className="text-[10px] font-mono text-text-muted">
                  {page.updated}
                </span>
              </div>
              <h3 className="mb-1 truncate text-sm font-semibold text-text-primary transition-colors group-hover:text-cyan-400">
                {page.title}
              </h3>
              <p className="mb-3 line-clamp-2 text-xs text-text-secondary leading-relaxed">
                {page.summary}
              </p>
              <div className="flex items-center justify-between gap-2 border-t border-border-subtle/20 pt-2.5">
                {page.confidence !== null ? (
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[9px] font-mono text-text-muted">conf:</span>
                    <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-4">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${page.confidence * 100}%`,
                          backgroundColor:
                            page.confidence >= 0.8
                              ? "#10b981"
                              : page.confidence >= 0.5
                                ? "#f59e0b"
                                : "#ef4444",
                        }}
                      />
                    </div>
                    <span className="text-[9px] font-mono text-text-muted">
                      {page.confidence.toFixed(2)}
                    </span>
                  </div>
                ) : (
                  <span />
                )}
                {page.inboundCount !== null && page.outboundCount !== null ? (
                  <span className="text-[9px] font-mono text-text-muted flex-shrink-0">
                    in:{page.inboundCount} out:{page.outboundCount}
                  </span>
                ) : null}
              </div>
            </Link>
          ))}
        </div>
      </GlassPanel>
    </div>
  );
}
