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
    const list = screen.getByRole("listbox", { name: "Keyboard list" });

    list.focus();
    fireEvent.keyDown(list, { key: "j" });

    expect(screen.getByText("beta")).toHaveAttribute("data-focused", "true");

    fireEvent.keyDown(list, { key: "k" });

    expect(screen.getByText("alpha")).toHaveAttribute("data-focused", "true");
  });

  test("Enter activates the focused item", () => {
    const onActivate = vi.fn();
    render(<KeyboardList onActivate={onActivate} />);
    const list = screen.getByRole("listbox", { name: "Keyboard list" });

    list.focus();
    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(list, { key: "Enter" });

    expect(onActivate).toHaveBeenCalledWith("beta", 1);
  });

  test("J and K do nothing when an input has focus", () => {
    render(<KeyboardList />);
    const input = screen.getByLabelText("Editable field");
    const list = screen.getByRole("listbox", { name: "Keyboard list" });

    input.focus();
    fireEvent.keyDown(list, { key: "j" });

    expect(screen.getByText("alpha")).toHaveAttribute("data-focused", "true");
  });

  test("uses listbox and option roles so aria-selected is valid", () => {
    render(<KeyboardList />);

    expect(screen.getByRole("listbox", { name: "Keyboard list" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "alpha" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "beta" })).toHaveAttribute("aria-selected", "false");
  });
});
