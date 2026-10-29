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

const usable = (el: HTMLElement) => el.isConnected && !el.closest("[hidden], [inert]") && shown(el);

function take(el: HTMLElement | null | undefined): boolean {
  if (!el || !usable(el)) return false;
  el.focus();
  return document.activeElement === el;
}

const onBody = () => !document.activeElement || document.activeElement === document.body;

let history: HTMLElement[] = [];
let parked = false;
let uninstall: (() => void) | null = null;

// Tries each candidate in turn, as one can look usable and still refuse focus, like a landmark whose tabindex went.
const resume = (exclude: (node: Node) => boolean, from: HTMLElement[] = history) =>
  from.some((el) => !exclude(el) && take(el));

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
      if (!parked && onBody()) resume(() => false);
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
  return history.find((el) => !exclude(el) && usable(el)) ?? null;
}

// A landmark is no control, so it takes focus by tabindex -1 and data-focus-landing drops the ring (_dialog.scss).
// The tabindex goes once focus moves on, so a blank click cannot focus it, but not on the blur of the window leaving.
export function mainLandmark(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(LANDMARK);
  if (!el) return null;
  el.setAttribute("data-focus-landing", "");
  if (el.hasAttribute("tabindex")) return el;
  el.setAttribute("tabindex", "-1");
  const off = () =>
    setTimeout(() => {
      if (document.activeElement === el) return;
      el.removeAttribute("tabindex");
      el.removeEventListener("blur", off);
    });
  el.addEventListener("blur", off);
  return el;
}

/** Remembers what holds focus now, for an overlay that gives it back on close. The returned `restore` refocuses it
 *  only while focus is still inside `within` or lost to the body, never when the user moved on to something else.
 *  When the opener is gone it tries `fallback`, then the last tracked control outside `within`, then the main
 *  landmark. With no opener at all (focus sat on the body) only `fallback` is tried. `from` names the opener
 *  when it is known better than by what holds focus, as WebKit does not focus a clicked button. */
export function focusReturn(
  fallback?: () => HTMLElement | null | undefined,
  from: Element | null = document.activeElement,
): {
  restore: (within: (node: Node) => boolean) => void;
} {
  const opener = from instanceof HTMLElement && from !== document.body ? from : null;
  // A long overlay's own controls can push everything before it out of the capped history.
  const before = history.slice();
  return {
    restore(within) {
      const now = document.activeElement;
      if (now && now !== document.body && !within(now)) return;
      if (take(opener) || take(fallback?.()) || !opener) return;
      if (!resume((n) => n === opener || within(n), [...history, ...before])) take(mainLandmark());
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
