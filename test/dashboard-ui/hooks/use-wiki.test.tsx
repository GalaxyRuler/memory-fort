import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { usePageDetail } from "../../../src/dashboard-ui/hooks/usePageDetail.js";
import { useWikiIndex } from "../../../src/dashboard-ui/hooks/useWikiIndex.js";

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function WikiProbe() {
  const wiki = useWikiIndex();
  if (wiki.isLoading) return <p>loading</p>;
  if (wiki.isError) return <p>error</p>;
  return <p>project title: {wiki.data.byCategory.projects[0]?.title}</p>;
}

function PageProbe() {
  usePageDetail("wiki/projects/foo.md");
  return null;
}

describe("wiki data hooks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("useWikiIndex fetches /api/wiki", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            byCategory: {
              projects: [
                {
                  category: "projects",
                  slug: "foo",
                  relPath: "wiki/projects/foo.md",
                  title: "Foo",
                  summary: "Foo summary",
                  updated: "2026-05-24",
                },
              ],
            },
            total: 1,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithQueryClient(<WikiProbe />);

    await waitFor(() => {
      expect(screen.getByText("project title: Foo")).toBeInTheDocument();
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/memory/api/wiki");
  });

  test("usePageDetail fetches encoded /api/page path", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            relPath: "wiki/projects/foo.md",
            frontmatter: { title: "Foo" },
            body: "Foo body",
            relations: [],
            inbound: [],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithQueryClient(<PageProbe />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/memory/api/page/wiki%2Fprojects%2Ffoo.md");
  });
});
