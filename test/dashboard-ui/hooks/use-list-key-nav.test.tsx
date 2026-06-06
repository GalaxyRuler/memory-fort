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

function KeyboardListWithDisclosure({ onActivate = vi.fn() }: { onActivate?: (item: string) => void }) {
  const items = ["alpha", "beta"];
  const nav = useListKeyNav({
    items,
    getKey: (item) => item,
    onActivate,
  });

  return (
    <ul aria-label="Keyboard list" {...nav.listProps}>
      {items.map((item, index) => (
        <li key={item} {...nav.getItemProps(index)}>
          {item}
          {index === 0 ? (
            <details data-testid="match-details">
              <summary
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.currentTarget.parentElement?.toggleAttribute("open");
                }}
              >
                Why this matched
              </summary>
            </details>
          ) : null}
        </li>
      ))}
    </ul>
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

  test("keeps native list semantics without listbox-only attributes", () => {
    render(<KeyboardList />);

    const list = screen.getByRole("list", { name: "Keyboard list" });
    const items = screen.getAllByRole("listitem");

    expect(list).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(items[0]).toHaveAttribute("data-focused", "true");
    expect(items[0]).not.toHaveAttribute("aria-selected");
    expect(items[1]).not.toHaveAttribute("aria-selected");
  });

  test("Enter and Space on an interactive summary toggle it without activating the option", () => {
    const onActivate = vi.fn();
    render(<KeyboardListWithDisclosure onActivate={onActivate} />);
    const summary = screen.getByText("Why this matched");
    const details = screen.getByTestId("match-details");

    summary.focus();
    fireEvent.keyDown(summary, { key: "Enter" });

    expect(details).toHaveAttribute("open");
    expect(onActivate).not.toHaveBeenCalled();

    fireEvent.keyDown(summary, { key: " " });

    expect(details).not.toHaveAttribute("open");
    expect(onActivate).not.toHaveBeenCalled();
  });
});
