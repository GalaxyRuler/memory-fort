import { describe, expect, test, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
}));

describe("Search route", () => {
  test("canonicalizes valid includeArchived query values", async () => {
    const { Route } = await import("../../../src/dashboard-ui/routes/search.js");
    const validateSearch = Route.options.validateSearch as (
      search: Record<string, unknown>,
    ) => Record<string, unknown>;

    expect(validateSearch({
      q: "needle",
      scope: "crystals",
      includeArchived: "1",
    })).toEqual({
      q: "needle",
      scope: "crystals",
      k: undefined,
      noRerank: undefined,
      includeArchived: "1",
    });
  });
});
