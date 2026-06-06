import {
  type HTMLAttributes,
  type KeyboardEvent,
  type RefCallback,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface UseListKeyNavOptions<T> {
  items: T[];
  getKey: (item: T, index: number) => string;
  onActivate: (item: T, index: number) => void;
}

export interface ListKeyNavResult {
  focusedIndex: number;
  listProps: HTMLAttributes<HTMLElement> & { ref: RefCallback<HTMLElement> };
  getItemProps: (index: number) => HTMLAttributes<HTMLElement> & { ref: RefCallback<HTMLElement> };
}

export function useListKeyNav<T>({
  items,
  getKey,
  onActivate,
}: UseListKeyNavOptions<T>): ListKeyNavResult {
  const [focusedIndex, setFocusedIndex] = useState(() => (items.length > 0 ? 0 : -1));
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const shouldFocusItemRef = useRef(false);
  const listElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setFocusedIndex((current) => {
      if (items.length === 0) return -1;
      if (current < 0) return 0;
      return Math.min(current, items.length - 1);
    });
  }, [items.length]);

  useEffect(() => {
    if (!shouldFocusItemRef.current || focusedIndex < 0) return;
    shouldFocusItemRef.current = false;
    const item = items[focusedIndex];
    if (!item) return;

    const element = itemRefs.current.get(getKey(item, focusedIndex));
    element?.focus();
    if (typeof element?.scrollIntoView === "function") {
      element.scrollIntoView({ block: "nearest" });
    }
  }, [focusedIndex, getKey, items]);

  const moveFocus = useCallback((nextIndex: number) => {
    if (items.length === 0) return;
    shouldFocusItemRef.current = true;
    setFocusedIndex(Math.max(0, Math.min(nextIndex, items.length - 1)));
  }, [items.length]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (isEditableElement(document.activeElement) || isInteractiveEventTarget(event)) return;

      if (event.key === "j" || event.key === "J") {
        event.preventDefault();
        moveFocus((focusedIndex < 0 ? 0 : focusedIndex) + 1);
        return;
      }

      if (event.key === "k" || event.key === "K") {
        event.preventDefault();
        moveFocus((focusedIndex < 0 ? 0 : focusedIndex) - 1);
        return;
      }

      if (event.key === "Enter" && focusedIndex >= 0) {
        const item = items[focusedIndex];
        if (!item) return;
        event.preventDefault();
        onActivate(item, focusedIndex);
      }
    },
    [focusedIndex, items, moveFocus, onActivate],
  );

  const listProps = useMemo(
    () => ({
      ref: (element: HTMLElement | null) => {
        listElementRef.current = element;
      },
      tabIndex: 0,
      onKeyDown,
    }),
    [onKeyDown],
  );

  const getItemProps = useCallback(
    (index: number) => {
      const item = items[index];
      const key = item ? getKey(item, index) : String(index);
      const isFocused = focusedIndex === index;
      return {
        ref: (element: HTMLElement | null) => {
          if (element) itemRefs.current.set(key, element);
          else itemRefs.current.delete(key);
        },
        tabIndex: isFocused ? 0 : -1,
        "data-focused": isFocused ? "true" : "false",
        onFocus: () => setFocusedIndex(index),
        onClick: () => setFocusedIndex(index),
      };
    },
    [focusedIndex, getKey, items],
  );

  return { focusedIndex, listProps, getItemProps };
}

const INTERACTIVE_DESCENDANT_SELECTOR = [
  "a[href]",
  "button",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='menuitem']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']",
].join(",");

function isInteractiveEventTarget(event: KeyboardEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (isEditableElement(target)) return true;
  if (target === event.currentTarget) return false;

  const interactiveElement = target.closest(INTERACTIVE_DESCENDANT_SELECTOR);
  return interactiveElement !== null && event.currentTarget.contains(interactiveElement);
}

function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;

  const tagName = element.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}
