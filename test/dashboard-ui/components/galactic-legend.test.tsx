import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Legend } from "../../../src/dashboard-ui/components/galactic/Legend.js";

describe("Galactic legend", () => {
  it("renders cognitive galaxies, domain shapes, and physics legend rows", () => {
    render(<Legend />);

    expect(screen.getByText("Cognitive Galaxies")).toBeInTheDocument();
    expect(screen.getByText("Core")).toBeInTheDocument();
    expect(screen.getByText("Semantic")).toBeInTheDocument();
    expect(screen.getByText("Episodic")).toBeInTheDocument();
    expect(screen.getByText("Procedural")).toBeInTheDocument();
    expect(screen.getByText("Domain Shapes")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Decisions")).toBeInTheDocument();
    expect(screen.getByText("Lessons")).toBeInTheDocument();
    expect(screen.getByText("References")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Crystals")).toBeInTheDocument();
    expect(screen.getByText("orbit pull · inbound count")).toBeInTheDocument();
    expect(screen.getByText("glow halo · confidence")).toBeInTheDocument();
    expect(screen.getByText("edge lens · relation weight")).toBeInTheDocument();
  });
});
