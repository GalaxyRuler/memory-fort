import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { GraphDetailPanel } from "../../../src/dashboard-ui/components/GraphDetailPanel.js";
import { type GraphNode } from "../../../src/dashboard-ui/hooks/useGraph.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, ...rest }: any) => (
    <a href={`${to}/${params?.category ?? ""}/${params?.slug ?? ""}`} {...rest}>
      {children}
    </a>
  ),
}));

function sampleNode(): GraphNode {
  return {
    path: "wiki/projects/memory-system.md",
    title: "Memory System",
    kind: "wiki",
    type: "projects",
    confidence: 0.9,
    updated: "2026-05-24",
    inboundCount: 4,
    outboundCount: 7,
  };
}

function vectorNode(): GraphNode {
  return {
    ...sampleNode(),
    confidence: { extraction: 0.82 } as never,
  };
}

function PanelHarness({ onCloseSpy }: { onCloseSpy: () => void }) {
  const [node, setNode] = useState<GraphNode | null>(null);

  return (
    <>
      <button type="button" onClick={() => setNode(sampleNode())}>
        Open panel
      </button>
      <GraphDetailPanel
        node={node}
        onClose={() => {
          onCloseSpy();
          setNode(null);
        }}
      />
    </>
  );
}

describe("GraphDetailPanel", () => {
  it("closes on Esc and restores focus to the previously focused element", () => {
    const onClose = vi.fn();
    render(<PanelHarness onCloseSpy={onClose} />);

    const openButton = screen.getByRole("button", { name: "Open panel" });
    openButton.focus();
    fireEvent.click(openButton);

    expect(screen.getByText("Memory System")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Memory System")).not.toBeInTheDocument();
    expect(openButton).toHaveFocus();
  });

  it("renders vector confidence as a scalar score", () => {
    render(<GraphDetailPanel node={vectorNode()} onClose={vi.fn()} />);

    expect(screen.getByText("0.82")).toBeInTheDocument();
  });
});
