// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useListKeyNav } from "../../../src/dashboard-ui/hooks/useListKeyNav.js";

function KeyboardList({ onActivate = vi.fn() }: { onActivate?: (item: string) => void }) {
  const items = ["alpha", "beta", "gamma"];
  const nav = useListKeyNav({
    items,
    getKey: (item) => item,
    onActivate,
  });

  return (
    <>
      <input aria-label="Editable field" />
      <ul aria-label="Keyboard list" {...nav.listProps}>
        {items.map((item, index) => (
          <li key={item} {...nav.getItemProps(index)}>
            {item}
          </li>
        ))}
      </ul>
    </>
  );
}

describe("useListKeyNav", () => {
  test("J advances focus and K retreats", () => {
    render(<KeyboardList />);
    const list = screen.getByRole("list", { name: "Keyboard list" });

    list.focus();
    fireEvent.keyDown(list, { key: "j" });

    expect(screen.getByText("beta")).toHaveAttribute("data-focused", "true");

    fireEvent.keyDown(list, { key: "k" });

    expect(screen.getByText("alpha")).toHaveAttribute("data-focused", "true");
  });

  test("Enter activates the focused item", () => {
    const onActivate = vi.fn();
    render(<KeyboardList onActivate={onActivate} />);
    const list = screen.getByRole("list", { name: "Keyboard list" });

    list.focus();
    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(list, { key: "Enter" });

    expect(onActivate).toHaveBeenCalledWith("beta", 1);
  });

  test("J and K do nothing when an input has focus", () => {
    render(<KeyboardList />);
    const input = screen.getByLabelText("Editable field");
    const list = screen.getByRole("list", { name: "Keyboard list" });

    input.focus();
    fireEvent.keyDown(list, { key: "j" });

    expect(screen.getByText("alpha")).toHaveAttribute("data-focused", "true");
  });

  test("preserves native list semantics without selection ARIA", () => {
    render(<KeyboardList />);

    const list = screen.getByRole("list", { name: "Keyboard list" });
    const alpha = screen.getByText("alpha");
    const beta = screen.getByText("beta");

    expect(screen.queryByRole("listbox", { name: "Keyboard list" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "alpha" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "beta" })).not.toBeInTheDocument();
    expect(list).not.toHaveAttribute("role");
    expect(alpha).not.toHaveAttribute("role");
    expect(alpha).not.toHaveAttribute("aria-selected");
    expect(beta).not.toHaveAttribute("role");
    expect(beta).not.toHaveAttribute("aria-selected");
    expect(alpha).toHaveAttribute("tabindex", "0");
    expect(beta).toHaveAttribute("tabindex", "-1");
  });
});
