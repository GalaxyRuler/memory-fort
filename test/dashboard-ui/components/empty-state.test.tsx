import { render, screen } from "@testing-library/react";
import { Search } from "lucide-react";
import { describe, expect, test } from "vitest";
import { EmptyState } from "../../../src/dashboard-ui/components/EmptyState.js";

describe("EmptyState", () => {
  test("renders icon, title, and description without an action by default", () => {
    render(
      <EmptyState
        icon={Search}
        title="No results"
        description="Try a different query or filter."
      />,
    );

    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.getByText("Try a different query or filter.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByTestId("empty-state-icon")).toBeInTheDocument();
  });
});
