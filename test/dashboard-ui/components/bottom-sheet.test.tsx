import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { BottomSheet } from "../../../src/dashboard-ui/components/BottomSheet.js";

describe("BottomSheet", () => {
  test("renders its heading and content when open", () => {
    render(
      <BottomSheet isOpen={true} title="Details" onClose={vi.fn()}>
        <p>Sheet content</p>
      </BottomSheet>,
    );

    expect(screen.getByRole("dialog", { name: "Details" })).toBeInTheDocument();
    expect(screen.getByText("Sheet content")).toBeInTheDocument();
  });

  test("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen={true} title="Details" onClose={onClose}>
        <p>Sheet content</p>
      </BottomSheet>,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("closes on backdrop click", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet isOpen={true} title="Details" onClose={onClose}>
        <p>Sheet content</p>
      </BottomSheet>,
    );

    fireEvent.click(screen.getByTestId("bottom-sheet-backdrop"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
