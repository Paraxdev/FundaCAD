const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(", ");

/** The Tab stops under `root`, in document order. A roving group counts once, by its one `tabindex="0"` item. */
export function focusables(root: Element | null | undefined): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getAttribute("tabindex") !== "-1" && !el.closest("[hidden], [inert]"),
  );
}

/** Remembers what holds focus now, for an overlay that gives it back on close. The returned `restore` refocuses it
 *  only while focus is still inside `within` or lost to the body, never when the user moved on to something else. */
export function focusReturn(fallback?: () => HTMLElement | null | undefined): {
  restore: (within: (node: Node) => boolean) => void;
} {
  const prev = document.activeElement;
  const opener = prev instanceof HTMLElement && prev !== document.body ? prev : null;
  return {
    restore(within) {
      const now = document.activeElement;
      if (now && now !== document.body && !within(now)) return;
      const target = opener?.isConnected ? opener : fallback?.();
      if (target?.isConnected) target.focus();
    },
  };
}
