const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(", ");
const LANDMARK = 'main, [role="main"], #main';
const HISTORY = 8;

/** The Tab stops under `root`, in document order. A roving group counts once, by its one `tabindex="0"` item. */
export function focusables(root: Element | null | undefined): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getAttribute("tabindex") !== "-1" && !el.closest("[hidden], [inert]") && shown(el),
  );
}

// Walks up for display:none instead of reading getClientRects, which happy-dom fills even for a hidden element.
function shown(el: HTMLElement): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) if (getComputedStyle(n).display === "none") return false;
  return getComputedStyle(el).visibility !== "hidden";
}

function take(el: HTMLElement | null | undefined): boolean {
  if (!el?.isConnected || el.closest("[hidden], [inert]") || !shown(el)) return false;
  el.focus();
  return document.activeElement === el;
}

const onBody = () => !document.activeElement || document.activeElement === document.body;

let history: HTMLElement[] = [];
let parked = false;
let uninstall: (() => void) | null = null;

/** Starts the focus history that `focusReturn`, `withFocusReturn` and the window focus listener fall back on.
 *  Idempotent, the returned stop clears it for tests. */
export function trackFocus(): () => void {
  if (uninstall) return uninstall;
  const onIn = (e: FocusEvent) => {
    if (!(e.target instanceof HTMLElement) || e.target === document.body) return;
    parked = false;
    history = [e.target, ...history.filter((h) => h !== e.target && h.isConnected)].slice(0, HISTORY);
  };
  // Focus that drops to the body while the window still has it was left there on purpose (a click on the canvas,
  // a field that blurs itself on Enter), so a later window focus must not pull it back into a field.
  const onOut = (e: FocusEvent) => {
    if (e.relatedTarget) return;
    setTimeout(() => {
      if (document.hasFocus() && onBody()) parked = true;
    });
  };
  // WebView2, WKWebView and WebKitGTK differ on what they refocus after Alt+Tab or a native dialog, so wait for
  // the engine and only step in when it left focus on the body.
  const onWindow = () => {
    setTimeout(() => {
      if (!parked && onBody()) take(history[0]);
    });
  };
  document.addEventListener("focusin", onIn, true);
  document.addEventListener("focusout", onOut, true);
  window.addEventListener("focus", onWindow);
  uninstall = () => {
    document.removeEventListener("focusin", onIn, true);
    document.removeEventListener("focusout", onOut, true);
    window.removeEventListener("focus", onWindow);
    history = [];
    parked = false;
    uninstall = null;
  };
  return uninstall;
}

/** The most recent tracked control that can still take focus and is not excluded. */
export function lastFocus(exclude: (node: Node) => boolean = () => false): HTMLElement | null {
  return history.find((el) => el.isConnected && !exclude(el) && !el.closest("[hidden], [inert]") && shown(el)) ?? null;
}

// A landmark is no control, so it takes focus by tabindex -1 and data-focus-landing drops the ring (_dialog.scss).
export function mainLandmark(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(LANDMARK);
  if (el && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el?.setAttribute("data-focus-landing", "");
  return el;
}

/** Remembers what holds focus now, for an overlay that gives it back on close. The returned `restore` refocuses it
 *  only while focus is still inside `within` or lost to the body, never when the user moved on to something else.
 *  When the opener is gone it tries `fallback`, then the last tracked control outside `within`, then the main
 *  landmark. With no opener at all (focus sat on the body) only `fallback` is tried. */
export function focusReturn(fallback?: () => HTMLElement | null | undefined): {
  restore: (within: (node: Node) => boolean) => void;
} {
  const prev = document.activeElement;
  const opener = prev instanceof HTMLElement && prev !== document.body ? prev : null;
  return {
    restore(within) {
      const now = document.activeElement;
      if (now && now !== document.body && !within(now)) return;
      if (take(opener) || take(fallback?.()) || !opener) return;
      if (!take(lastFocus((n) => n === opener || within(n)))) take(mainLandmark());
    },
  };
}

/** Runs `fn`, a native dialog or anything else that takes focus out of the webview, and hands focus back to the
 *  control that called it when the engine leaves it on the body. */
export async function withFocusReturn<T>(fn: () => Promise<T> | T): Promise<T> {
  if (typeof document === "undefined") return await fn();
  const back = focusReturn();
  try {
    return await fn();
  } finally {
    back.restore(() => false);
  }
}
