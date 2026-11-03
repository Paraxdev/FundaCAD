import { typesAhead } from "../ui/focus";

export interface ToolFocusHost {
  sketch: { active: boolean };
  toolAtWork(): boolean;
  viewport: { domElement: HTMLElement };
}

const LISTS = '[role="listbox"], [role="tree"], [role="treegrid"], [role="grid"]';
// The palette starts most tools from the keyboard, and like a menu it hands focus back when it closes.
const PASSING = '[role="dialog"], [role="alertdialog"], [role="menu"], .ui-menu';
const SURFACE = "[data-key-surface]";

type Place = { el: HTMLElement; list: Element | null };

const onPage = (a: Element | null) => a === null || a === document.body || a === document.documentElement;

/** A tool's own box takes focus and drops it on the page when it goes, where the next key runs a shortcut and Tab starts
 *  over. When a key started the tool, focus from before it goes back then, to the list's tab stop if a build replaced
 *  the row, however that focus got there. A tool a pointer started gives nothing back. A sketch started from a list
 *  takes focus out of it, or its keys would type ahead there: to the sketch's key surface, what a screen reader types
 *  into, or to the canvas while no draw tool makes the surface a Tab stop. After a key start focus goes back to the list
 *  when the sketch ends if it is still in the view, after a click it stays in the view. Frames, as restoreWhenIdle,
 *  since no tool says when it starts or ends. */
export function installToolFocus(
  e: ToolFocusHost,
  o: { frame?: (fn: () => void) => number; cancelFrame?: (id: number) => void } = {},
): () => void {
  const frame = o.frame ?? requestAnimationFrame;
  const cancelFrame = o.cancelFrame ?? cancelAnimationFrame;
  let sketching = false;
  let working = false;
  let idle = 0;
  let lastKey = false;
  let byKey = false;
  let seen: Element | null = null;
  let from: Place | null = null;
  let moved: Place | null = null;
  let handle = 0;

  // As F6 into the view does.
  function enterView(view: HTMLElement) {
    const surface = document.querySelector<HTMLElement>(SURFACE);
    if (surface && surface.tabIndex >= 0) surface.focus({ preventScroll: true });
    if (!surface || document.activeElement !== surface) view.focus({ preventScroll: true });
  }

  function giveBack(to: Place) {
    const stop = to.list?.isConnected ? to.list.querySelector<HTMLElement>('[tabindex="0"]') : null;
    const target = to.el.isConnected ? to.el : stop;
    if (target && !target.closest("[inert], [hidden]")) target.focus();
  }

  function remember(a: Element | null) {
    if (a === seen || a?.closest(PASSING)) return;
    seen = a;
    from = a instanceof HTMLElement && !onPage(a) ? { el: a, list: a.closest(LISTS) } : null;
  }
  // Input during a tool belongs to the tool, so the last one before it says what started it.
  const onInput = (ev: Event) => {
    if (!e.toolAtWork()) lastKey = ev.type === "keydown";
  };
  // Keys can move focus to a row and start a tool from it between two frames, so focus is heard as it moves too.
  const onFocusIn = (ev: FocusEvent) => {
    if (!working && !e.toolAtWork()) remember(ev.target as Element);
  };

  const tick = () => {
    const view = e.viewport.domElement;
    if (e.sketch.active && !sketching) {
      const a = document.activeElement;
      if (a instanceof HTMLElement && !onPage(a) && typesAhead(a)) {
        moved = { el: a, list: a.closest(LISTS) };
        enterView(view);
      }
    }
    sketching = e.sketch.active;
    handle = frame(tick);
    if (e.toolAtWork()) {
      if (!working || idle > 0) byKey = lastKey;
      working = true;
      idle = 0;
      return;
    }
    // Idle must hold two frames, as restoreWhenIdle's, or a pick handed on would see focus on the page in between.
    if (working && ++idle < 2) return;
    if (working) {
      const a = document.activeElement;
      const to = moved ?? from;
      const inView = a === view || !!a?.matches(SURFACE);
      if (byKey && to && (onPage(a) || (moved && inView))) giveBack(to);
      // The surface goes with the sketch and drops focus on the page.
      else if (moved && onPage(a)) view.focus({ preventScroll: true });
      moved = null;
    }
    working = false;
    remember(document.activeElement);
  };
  handle = frame(tick);
  document.addEventListener("focusin", onFocusIn, true);
  window.addEventListener("keydown", onInput, true);
  window.addEventListener("pointerdown", onInput, true);
  return () => {
    cancelFrame(handle);
    document.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("keydown", onInput, true);
    window.removeEventListener("pointerdown", onInput, true);
  };
}
