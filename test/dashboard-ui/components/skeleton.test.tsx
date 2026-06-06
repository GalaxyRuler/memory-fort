import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Skeleton } from "../../../src/dashboard-ui/components/Skeleton.js";

const originalMatchMedia = window.matchMedia;

function setReducedMotion(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("Skeleton", () => {
  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  test("renders line, block, and card variants", () => {
    render(
      <>
        <Skeleton aria-label="Line skeleton" variant="line" />
        <Skeleton aria-label="Block skeleton" variant="block" />
        <Skeleton aria-label="Card skeleton" variant="card" />
      </>,
    );

    expect(screen.getByLabelText("Line skeleton")).toHaveAttribute("data-variant", "line");
    expect(screen.getByLabelText("Block skeleton")).toHaveAttribute("data-variant", "block");
    expect(screen.getByLabelText("Card skeleton")).toHaveAttribute("data-variant", "card");
  });

  test("does not use shimmer animation when reduced motion is requested", () => {
    setReducedMotion(true);

    render(<Skeleton aria-label="Reduced skeleton" variant="card" />);

    expect(screen.getByLabelText("Reduced skeleton")).not.toHaveClass("animate-shimmer");
  });
});
