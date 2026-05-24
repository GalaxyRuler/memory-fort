// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useDebouncedValue } from "../../../src/dashboard-ui/hooks/useDebouncedValue.js";

describe("useDebouncedValue", () => {
  test("returns initial value immediately, then updated value after delay", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 150),
      { initialProps: { value: "initial" } },
    );

    expect(result.current).toBe("initial");

    rerender({ value: "updated" });
    expect(result.current).toBe("initial");

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current).toBe("updated");
    vi.useRealTimers();
  });

  test("cancels previous timer on rapid changes", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 150),
      { initialProps: { value: "one" } },
    );

    rerender({ value: "two" });
    act(() => {
      vi.advanceTimersByTime(75);
    });
    rerender({ value: "three" });
    act(() => {
      vi.advanceTimersByTime(75);
    });
    rerender({ value: "four" });

    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(result.current).toBe("one");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("four");
    vi.useRealTimers();
  });
});
