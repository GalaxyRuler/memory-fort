import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { isNewVault, WelcomeCard } from "../../../src/dashboard-ui/components/WelcomeCard.js";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  };
});

describe("WelcomeCard", () => {
  test("renders a plain-language intro and next-step links", () => {
    render(<WelcomeCard />);

    expect(screen.getByRole("heading", { name: /welcome to memory fort/i })).toBeInTheDocument();
    // No jargon in the intro.
    expect(screen.getByText(/remembers things across your ai tools/i)).toBeInTheDocument();
    // Concrete next steps link to Settings and Search.
    const settingsLink = screen.getByRole("link", { name: /connect your tools/i });
    expect(settingsLink).toHaveAttribute("href", "/settings");
    const searchLink = screen.getByRole("link", { name: /search what'?s saved/i });
    expect(searchLink).toHaveAttribute("href", "/search");
  });
});

describe("isNewVault", () => {
  test("true when the vault has few or no curated pages", () => {
    expect(isNewVault({ wikiPages: 0, rawObservations: 0 })).toBe(true);
    expect(isNewVault({ wikiPages: 1, rawObservations: 4 })).toBe(true);
    expect(isNewVault({ wikiPages: 2, rawObservations: 50 })).toBe(true);
  });

  test("false once the vault has accumulated knowledge", () => {
    expect(isNewVault({ wikiPages: 3, rawObservations: 0 })).toBe(false);
    expect(isNewVault({ wikiPages: 42, rawObservations: 600 })).toBe(false);
  });

  test("false when counts are not loaded yet (avoid flashing the welcome card)", () => {
    expect(isNewVault(undefined)).toBe(false);
  });
});
