import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { routeTree } from "../../../src/dashboard-ui/routeTree.gen.js";
import { apiGet } from "../../../src/dashboard-ui/lib/api.js";
import type { PageDetail } from "../../../src/dashboard-ui/hooks/usePageDetail.js";
import type { RawSessionDetail } from "../../../src/dashboard-ui/hooks/useRawSession.js";
import type { WikiIndex } from "../../../src/dashboard-ui/hooks/useWikiIndex.js";
import type { RawIndexEntry } from "../../../src/dashboard-ui/hooks/useRawIndex.js";

vi.mock("../../../src/dashboard-ui/lib/api.js", () => ({
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

describe("dashboard wiki/raw routing", () => {
  beforeEach(() => {
    mockApiGet.mockReset();
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
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function wikiPageFixture(): PageDetail {
  return {
    relPath: "wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md",
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
