import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../../src/dashboard-ui/components/Button.js";
import { Card } from "../../src/dashboard-ui/components/Card.js";
import { EntityIcon } from "../../src/dashboard-ui/components/EntityIcon.js";
import { GlassPanel } from "../../src/dashboard-ui/components/GlassPanel.js";
import { Input } from "../../src/dashboard-ui/components/Input.js";
import { StatusPill } from "../../src/dashboard-ui/components/StatusPill.js";
import { cn } from "../../src/dashboard-ui/lib/cn.js";

describe("dashboard UI base components", () => {
  it("GlassPanel renders children inside a div with the glass-blur class", () => {
    render(<GlassPanel data-testid="panel">Panel content</GlassPanel>);

    const panel = screen.getByTestId("panel");
    expect(panel).toHaveTextContent("Panel content");
    expect(panel).toHaveClass("glass-blur");
  });

  it("EntityIcon applies the correct entity color and size classes", () => {
    render(<EntityIcon type="projects" size="lg" />);

    const icon = screen.getByLabelText("projects entity");
    expect(icon).toHaveClass("bg-entity-projects");
    expect(icon).toHaveClass("w-3", "h-3");
  });

  it("StatusPill renders default label, child override, and variant classes", () => {
    const { rerender } = render(<StatusPill kind="active" />);

    const active = screen.getByText("active").closest("span");
    expect(active).toHaveClass("bg-status-green/20", "text-status-green");

    rerender(<StatusPill kind="conflict">needs review</StatusPill>);
    const conflict = screen.getByText("needs review").closest("span");
    expect(conflict).toHaveClass("bg-status-red/20", "text-status-red");

    rerender(<StatusPill kind="error">error</StatusPill>);
    const error = screen.getByText("error").closest("span");
    expect(error).toHaveClass("bg-status-red/20", "text-status-red");

    rerender(<StatusPill kind="unknown">unknown</StatusPill>);
    const unknown = screen.getByText("unknown").closest("span");
    expect(unknown).toHaveClass("bg-text-muted/20", "text-text-muted");
  });

  it("Card renders children with surface and border classes", () => {
    render(<Card data-testid="card">Card content</Card>);

    const card = screen.getByTestId("card");
    expect(card).toHaveTextContent("Card content");
    expect(card).toHaveClass("bg-surface");
  });

  it("Button fires onClick and applies primary classes", () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button).toHaveClass("bg-primary", "text-background");
  });

  it("Button applies secondary and ghost variant classes", () => {
    const { rerender } = render(<Button variant="secondary">Secondary</Button>);
    expect(screen.getByRole("button", { name: "Secondary" })).toHaveClass("border-border-emphasis");

    rerender(<Button variant="ghost">Ghost</Button>);
    expect(screen.getByRole("button", { name: "Ghost" })).toHaveClass("text-text-secondary");
  });

  it("Input propagates placeholder and onChange", () => {
    const onChange = vi.fn();
    render(<Input placeholder="Search memory" onChange={onChange} />);

    const input = screen.getByPlaceholderText("Search memory");
    fireEvent.change(input, { target: { value: "voyage" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("cn merges Tailwind classes with last conflicting utility winning", () => {
    expect(cn("px-2 text-sm", false && "hidden", "px-4", "text-lg")).toBe("px-4 text-lg");
  });
});
