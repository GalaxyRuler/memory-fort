import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryModal } from "../../../src/dashboard-ui/components/galactic/MemoryModal.js";
import type { GraphNode } from "../../../src/dashboard-ui/hooks/useGraph.js";

function renderWithClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function graphNode(path: string): GraphNode {
  return {
    path,
    title: path,
    kind: "wiki",
    type: "projects",
    cognitiveType: "semantic",
    status: "active",
    source: "manual",
    created: null,
    confidence: 0.8,
    tags: [],
    description: "",
    updated: null,
    inboundCount: 0,
    outboundCount: 0,
  };
}

describe("MemoryModal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens, fetches the page body, switches tabs, and closes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      relPath: "wiki/projects/foo.md",
      fullPath: "C:/memory/wiki/projects/foo.md",
      frontmatter: { title: "Foo" },
      body: "# Foo\n\nBody text.",
      relations: [],
      inbound: [],
    }), { status: 200 }));
    const onClose = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(
      <MemoryModal graphNodes={[]} open path="wiki/projects/foo.md" onClose={onClose} onSelectNode={vi.fn()} />,
    );

    await screen.findByRole("heading", { name: "Foo" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/memory/api/page/wiki%2Fprojects%2Ffoo.md");

    fireEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(screen.getByText(/# Foo/)).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("wikilink clicks close the modal and select existing graph node", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      relPath: "wiki/projects/foo.md",
      fullPath: "C:/memory/wiki/projects/foo.md",
      frontmatter: { title: "Foo" },
      body: "See [[wiki/projects/bar.md]].",
      relations: [],
      inbound: [],
    }), { status: 200 }));
    const onClose = vi.fn();
    const onSelectNode = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(
      <MemoryModal
        graphNodes={[graphNode("wiki/projects/bar.md")]}
        open
        path="wiki/projects/foo.md"
        onClose={onClose}
        onSelectNode={onSelectNode}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "[[wiki/projects/bar.md]]" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "[[wiki/projects/bar.md]]" }));

    expect(onSelectNode).toHaveBeenCalledWith("wiki/projects/bar.md");
    expect(onClose).toHaveBeenCalled();
  });
});
