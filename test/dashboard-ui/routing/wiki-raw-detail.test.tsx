import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { routeTree } from "../../../src/dashboard-ui/routeTree.gen.js";
import { apiFetch, apiGet } from "../../../src/dashboard-ui/lib/api.js";
import type { PageDetail } from "../../../src/dashboard-ui/hooks/usePageDetail.js";
import type { RawSessionDetail } from "../../../src/dashboard-ui/hooks/useRawSession.js";
import type { WikiIndex } from "../../../src/dashboard-ui/hooks/useWikiIndex.js";
import type { RawIndexEntry } from "../../../src/dashboard-ui/hooks/useRawIndex.js";

vi.mock("../../../src/dashboard-ui/lib/api.js", () => ({
  apiFetch: vi.fn(async () => ({ ok: false })),
  apiGet: vi.fn(),
}));

vi.mock("../../../src/dashboard-ui/hooks/useStatus.js", () => ({
  useStatus: () => ({
    isLoading: false,
    isError: false,
    data: {
      errorsLog: { isClean: true },
      generatedAt: "2026-05-25T12:00:00.000Z",
      syncState: {
        lastSyncAttempt: null,
        lastSyncSuccess: null,
        pendingPushCount: 0,
        conflictsPending: 0,
        conflictFiles: [],
        lastCheckoutAt: "2026-05-25T12:00:00.000Z",
        isStale: false,
      },
    },
  }),
}));

vi.mock("../../../src/dashboard-ui/hooks/useSyncState.js", () => ({
  useSyncState: () => ({
    isLoading: false,
    isError: false,
    data: {
      lastCheckoutAt: "2026-05-25T12:00:00.000Z",
      lastCommit: "60d9f22",
      status: "synced",
    },
  }),
}));

const mockApiGet = vi.mocked(apiGet);
const mockApiFetch = vi.mocked(apiFetch);

describe("dashboard wiki/raw routing", () => {
  beforeEach(() => {
    mockApiGet.mockReset();
    mockApiFetch.mockResolvedValue({ ok: false } as Response);
    vi.stubGlobal("scrollTo", vi.fn());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  test("mounts wiki detail on direct URL load", async () => {
    mockApiGet.mockImplementation(async (path) => {
      if (path === "/page/wiki%2Fdecisions%2F2026-05-20-voyage-ai-for-embeddings.md") {
        return wikiPageFixture() as never;
      }
      if (path === "/wiki") {
        return wikiIndexFixture() as never;
      }
      throw new Error(`unexpected api path ${path}`);
    });

    renderAt("/wiki/decisions/2026-05-20-voyage-ai-for-embeddings");

    expect(await screen.findByRole("heading", { name: "Voyage AI for Embeddings" })).toBeInTheDocument();
    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledTimes(1);
    });
    expect(mockApiGet).toHaveBeenCalledWith(
      "/page/wiki%2Fdecisions%2F2026-05-20-voyage-ai-for-embeddings.md",
    );
    expect(screen.queryByRole("heading", { name: "Wiki" })).not.toBeInTheDocument();
  });

  test("passes an explicit archive opt-in from a direct wiki detail URL to the page request", async () => {
    mockApiGet.mockImplementation(async (path, params) => {
      if (
        path === "/page/wiki%2Farchive%2Fold.md"
        && params?.includeArchived === "1"
      ) {
        return {
          ...wikiPageFixture(),
          relPath: "wiki/archive/old.md",
          archived: true,
          frontmatter: { ...wikiPageFixture().frontmatter, title: "Archived Decision" },
        } as never;
      }
      throw new Error(`unexpected api request ${path}`);
    });

    renderAt("/wiki/archive/old?includeArchived=1");

    expect(await screen.findByRole("heading", { name: "Archived Decision" })).toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledWith(
      "/page/wiki%2Farchive%2Fold.md",
      { includeArchived: "1" },
    );
  });

  test.each([
    {
      linkName: "Relation Target",
      destinationPath: "/wiki/archive/relation-target",
      requestPath: "/page/wiki%2Farchive%2Frelation-target.md",
    },
    {
      linkName: "Inbound Target",
      destinationPath: "/wiki/archive/inbound-target",
      requestPath: "/page/wiki%2Farchive%2Finbound-target.md",
    },
    {
      linkName: "body-alias",
      destinationPath: "/wiki/archive/body-target",
      requestPath: "/page/wiki%2Farchive%2Fbody-target.md",
    },
  ])("preserves archive opt-in through the $linkName wiki link", async ({
    linkName,
    destinationPath,
    requestPath,
  }) => {
    mockApiGet.mockImplementation(async (path, params) => {
      if (
        path === "/page/wiki%2Farchive%2Fsource.md"
        && params?.includeArchived === "1"
      ) {
        return linkedWikiPageFixture(true) as never;
      }
      if (path === requestPath && params?.includeArchived === "1") {
        return destinationWikiPageFixture(destinationPath) as never;
      }
      throw new Error(`unexpected api request ${path}`);
    });

    const { router } = renderAt("/wiki/archive/source?includeArchived=1");

    expect(await screen.findByRole("heading", { name: "Archived Source" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: linkName });
    expect(link).toHaveAttribute("href", `${destinationPath}?includeArchived=1`);

    mockApiGet.mockClear();
    fireEvent.click(link);

    await waitFor(() => {
      expect(router.state.location.href).toBe(`${destinationPath}?includeArchived=1`);
    });
    expect(await screen.findByRole("heading", { name: "Archive Destination" })).toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledWith(requestPath, { includeArchived: "1" });
  });

  test("keeps normal wiki links free of an archive opt-in", async () => {
    mockApiGet.mockImplementation(async (path, params) => {
      if (path === "/page/wiki%2Farchive%2Fsource.md" && params === undefined) {
        return linkedWikiPageFixture(false) as never;
      }
      if (path === "/page/wiki%2Farchive%2Fbody-target.md" && params === undefined) {
        return destinationWikiPageFixture("/wiki/archive/body-target") as never;
      }
      throw new Error(`unexpected api request ${path}`);
    });

    const { router } = renderAt("/wiki/archive/source");

    expect(await screen.findByRole("heading", { name: "Active Source" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Relation Target" }))
      .toHaveAttribute("href", "/wiki/archive/relation-target");
    expect(screen.getByRole("link", { name: "Inbound Target" }))
      .toHaveAttribute("href", "/wiki/archive/inbound-target");
    const bodyLink = screen.getByRole("link", { name: "body-alias" });
    expect(bodyLink).toHaveAttribute("href", "/wiki/archive/body-target");

    mockApiGet.mockClear();
    fireEvent.click(bodyLink);

    await waitFor(() => {
      expect(router.state.location.href).toBe("/wiki/archive/body-target");
    });
    expect(await screen.findByRole("heading", { name: "Archive Destination" })).toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledWith("/page/wiki%2Farchive%2Fbody-target.md");
  });

  test("mounts wiki index on /wiki", async () => {
    mockApiGet.mockImplementation(async (path) => {
      if (path === "/wiki") return wikiIndexFixture() as never;
      throw new Error(`unexpected api path ${path}`);
    });

    renderAt("/wiki");

    expect(await screen.findByText("1 curated pages")).toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledWith("/wiki");
  });

  test("mounts raw detail on direct URL load", async () => {
    mockApiGet.mockImplementation(async (path) => {
      if (path === "/raw/2026-05-25/codex-019e5a9c-memory-routing.md") {
        return rawSessionFixture() as never;
      }
      if (path === "/raw") {
        return rawIndexFixture() as never;
      }
      throw new Error(`unexpected api path ${path}`);
    });

    renderAt("/raw/2026-05-25/codex-019e5a9c-memory-routing.md");

    expect(await screen.findByRole("heading", { name: "019e5a9c-memory-routing" })).toBeInTheDocument();
    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledTimes(1);
    });
    expect(mockApiGet).toHaveBeenCalledWith("/raw/2026-05-25/codex-019e5a9c-memory-routing.md");
    expect(screen.queryByRole("heading", { name: "Raw observations" })).not.toBeInTheDocument();
  });

  test("mounts raw index on /raw", async () => {
    mockApiGet.mockImplementation(async (path) => {
      if (path === "/raw") return rawIndexFixture() as never;
      throw new Error(`unexpected api path ${path}`);
    });

    renderAt("/raw");

    expect(await screen.findByText("1 session captured")).toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledWith("/raw");
  });
});

function renderAt(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}

function wikiPageFixture(): PageDetail {
  return {
    relPath: "wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md",
    archived: false,
    frontmatter: {
      title: "Voyage AI for Embeddings",
      type: "decisions",
      created: "2026-05-20",
      updated: "2026-05-25",
      status: "active",
      confidence: 0.92,
      tags: ["search"],
    },
    body: "## Decision\nUse Voyage embeddings for semantic recall.",
    relations: [],
    inbound: [],
  };
}

function linkedWikiPageFixture(archived: boolean): PageDetail {
  return {
    relPath: "wiki/archive/source.md",
    archived,
    frontmatter: {
      title: archived ? "Archived Source" : "Active Source",
      type: "archive",
      status: archived ? "archived" : "active",
    },
    body: "See [[body-alias]].",
    relations: [
      {
        key: "uses",
        target: "relation-alias",
        resolvedPath: "wiki/archive/relation-target.md",
        resolvedTitle: "Relation Target",
      },
      {
        key: "references",
        target: "body-alias",
        resolvedPath: "wiki/archive/body-target.md",
        resolvedTitle: "Body Relation Resolver",
      },
    ],
    inbound: [
      {
        fromPath: "wiki/archive/inbound-target.md",
        fromTitle: "Inbound Target",
        via: "related_to",
      },
    ],
  };
}

function destinationWikiPageFixture(path: string): PageDetail {
  return {
    relPath: `${path.slice(1)}.md`,
    archived: true,
    frontmatter: {
      title: "Archive Destination",
      type: "archive",
      status: "archived",
    },
    body: "Destination body.",
    relations: [],
    inbound: [],
  };
}

function wikiIndexFixture(): WikiIndex {
  return {
    total: 12,
    byCategory: {
      decisions: [
        {
          category: "decisions",
          slug: "2026-05-20-voyage-ai-for-embeddings",
          relPath: "wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md",
          title: "Voyage AI for Embeddings",
          summary: "Use Voyage embeddings for semantic recall.",
          updated: "2026-05-25",
        },
      ],
    },
  };
}

function rawSessionFixture(): RawSessionDetail {
  return {
    date: "2026-05-25",
    filename: "codex-019e5a9c-memory-routing.md",
    relPath: "raw/2026-05-25/codex-019e5a9c-memory-routing.md",
    source: "codex",
    sessionId: "019e5a9c-memory-routing",
    sizeBytes: 512,
    mtime: "2026-05-25T12:00:00.000Z",
    body: "## Observation\nRouting detail should mount.",
    frontmatter: {},
  };
}

function rawIndexFixture(): RawIndexEntry[] {
  return [
    {
      date: "2026-05-25",
      files: [
        {
          filename: "codex-019e5a9c-memory-routing.md",
          sizeBytes: 512,
          mtime: "2026-05-25T12:00:00.000Z",
        },
      ],
    },
  ];
}
