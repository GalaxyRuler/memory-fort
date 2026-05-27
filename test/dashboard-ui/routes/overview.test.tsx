import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const statusHook = vi.hoisted(() => ({
  useStatus: vi.fn(),
}));
const activityHook = vi.hoisted(() => ({
  useActivity: vi.fn(),
}));
const wikiHook = vi.hoisted(() => ({
  useWikiIndex: vi.fn(),
}));
const graphHook = vi.hoisted(() => ({
  useGraph: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  Link: ({
    children,
    className,
    params,
    to,
  }: {
    children: ReactNode;
    className?: string;
    params?: Record<string, string>;
    to: string;
  }) => {
    const href = params
      ? to.replace("$category", params.category ?? "").replace("$slug", params.slug ?? "")
      : to;
    return (
      <a className={className} href={href}>
        {children}
      </a>
    );
  },
}));

vi.mock("../../../src/dashboard-ui/hooks/useStatus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useStatus.js")>();
  return {
    ...actual,
    useStatus: statusHook.useStatus,
  };
});

vi.mock("../../../src/dashboard-ui/hooks/useActivity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useActivity.js")>();
  return {
    ...actual,
    useActivity: activityHook.useActivity,
  };
});

vi.mock("../../../src/dashboard-ui/hooks/useWikiIndex.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useWikiIndex.js")>();
  return {
    ...actual,
    useWikiIndex: wikiHook.useWikiIndex,
  };
});

vi.mock("../../../src/dashboard-ui/hooks/useGraph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useGraph.js")>();
  return {
    ...actual,
    useGraph: graphHook.useGraph,
  };
});

vi.mock("../../../src/dashboard-ui/components/HealthBadge.js", () => ({
  HealthBadge: () => <div data-testid="health-badge" />,
}));

vi.mock("../../../src/dashboard-ui/components/GraphHealthPanel.js", () => ({
  GraphHealthPanel: () => <div data-testid="graph-health-panel" />,
}));

vi.mock("../../../src/dashboard-ui/components/NeedsAttention.js", () => ({
  NeedsAttention: () => <div data-testid="needs-attention" />,
}));

describe("Overview route", () => {
  beforeEach(() => {
    statusHook.useStatus.mockReset();
    activityHook.useActivity.mockReset();
    wikiHook.useWikiIndex.mockReset();
    graphHook.useGraph.mockReset();

    statusHook.useStatus.mockReturnValue({
      data: {
        vaultRoot: "C:/memory",
        repoHead: { shortSha: "abc123" },
        counts: { wikiPages: 4, rawObservations: 0, crystals: 0 },
        lastCompile: null,
        errorsLog: { sizeBytes: 0, lastLine: null, isClean: true },
        syncState: {
          lastSyncAttempt: null,
          lastSyncSuccess: null,
          pendingPushCount: 0,
          conflictsPending: 0,
          conflictFiles: [],
        },
        generatedAt: "2026-05-27T00:00:00.000Z",
      },
    });
    activityHook.useActivity.mockReturnValue({
      data: { events: [] },
      isLoading: false,
    });
  });

  test("omits confidence and edge badges from recently updated cards without graph data", async () => {
    const { Route } = await import("../../../src/dashboard-ui/routes/index.js");
    const Overview = Route.options.component as () => ReactNode;

    wikiHook.useWikiIndex.mockReturnValue({
      data: {
        byCategory: {
          projects: [
            {
              category: "projects",
              slug: "connected",
              relPath: "wiki/projects/connected.md",
              title: "Connected Project",
              summary: "A graph-connected page.",
              updated: "2026-05-27",
            },
          ],
          ".audit": [
            {
              category: ".audit",
              slug: "orphan",
              relPath: "wiki/.audit/orphan.md",
              title: "Audit Orphan",
              summary: "An audit page without graph data.",
              updated: "2026-05-26",
            },
          ],
        },
        total: 2,
      },
      isLoading: false,
    });
    graphHook.useGraph.mockReturnValue({
      data: {
        nodes: [
          {
            path: "wiki/projects/connected.md",
            title: "Connected Project",
            kind: "wiki",
            type: "projects",
            cognitiveType: "core",
            status: "active",
            source: "codex",
            created: "2026-05-20",
            confidence: 0.9,
            tags: [],
            description: "",
            updated: "2026-05-27",
            inboundCount: 2,
            outboundCount: 3,
          },
        ],
        edges: [],
        unresolvedTargets: [],
      },
    });

    render(<Overview />);

    const connectedCard = screen
      .getAllByText("Connected Project")
      .map((element) => element.closest("a"))
      .find((element): element is HTMLAnchorElement => element !== null);
    const orphanCard = screen.getByText("Audit Orphan").closest("a");
    expect(connectedCard).not.toBeNull();
    expect(orphanCard).not.toBeNull();

    expect(within(connectedCard!).getByText("conf:")).toBeInTheDocument();
    expect(within(connectedCard!).getByText("0.90")).toBeInTheDocument();
    expect(within(connectedCard!).getByText("in:2 out:3")).toBeInTheDocument();

    expect(within(orphanCard!).queryByText("conf:")).not.toBeInTheDocument();
    expect(within(orphanCard!).queryByText("0.75")).not.toBeInTheDocument();
    expect(within(orphanCard!).queryByText("in:0 out:0")).not.toBeInTheDocument();
  });
});
