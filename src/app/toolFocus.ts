import { typesAhead } from "../ui/focus";

export interface ToolFocusHost {
  sketch: { active: boolean };
  toolAtWork(): boolean;
  viewport: { domElement: HTMLElement };
}

const LISTS = '[role="listbox"], [role="tree"], [role="treegrid"], [role="grid"]';
// The palette starts most tools from the keyboard, and like a menu it hands focus back when it closes.
const PASSING = '[role="dialog"], [role="alertdialog"], [role="menu"], .ui-menu';

function keyboardShown(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

type Place = { el: HTMLElement; list: Element | null };

const onPage = (a: Element | null) => a === null || a === document.body || a === document.documentElement;

/** A tool's own box takes focus and drops it on the page when it goes, where the next key runs a shortcut and Tab starts
 *  over. A keyboard user's focus from before the tool goes back then, to the list's tab stop if a build replaced the
 *  row. Pointer focus is left alone. A sketch started from a list takes focus to the 3D view, or its keys would type
 *  ahead in the list, and gives it back to the list when it ends if focus is still there. Frames, as restoreWhenIdle,
 *  since no tool says when it starts or ends. */
export function installToolFocus(
  e: ToolFocusHost,
  o: {
    frame?: (fn: () => void) => number;
    cancelFrame?: (id: number) => void;
    shown?: (el: Element) => boolean;
  } = {},
): () => void {
  const frame = o.frame ?? requestAnimationFrame;
  const cancelFrame = o.cancelFrame ?? cancelAnimationFrame;
  const shown = o.shown ?? keyboardShown;
  let sketching = false;
  let working = false;
  let idle = 0;
  let seen: Element | null = null;
  let from: Place | null = null;
  let moved: Place | null = null;
  let handle = 0;

  function giveBack(to: Place) {
    const stop = to.list?.isConnected ? to.list.querySelector<HTMLElement>('[tabindex="0"]') : null;
    const target = to.el.isConnected ? to.el : stop;
    if (target && !target.closest("[inert], [hidden]")) target.focus();
  }

  function remember(a: Element | null) {
    if (a === seen || a?.closest(PASSING)) return;
    seen = a;
    from = a instanceof HTMLElement && !onPage(a) && shown(a) ? { el: a, list: a.closest(LISTS) } : null;
  }
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
        view.focus({ preventScroll: true });
      }
    }
    sketching = e.sketch.active;
    handle = frame(tick);
    if (e.toolAtWork()) {
      working = true;
      idle = 0;
      return;
    }
    // Idle must hold two frames, as restoreWhenIdle's, or a pick handed on would see focus on the page in between.
    if (working && ++idle < 2) return;
    if (working) {
      const a = document.activeElement;
      const to = moved ?? from;
      if (to && (onPage(a) || (moved && a === view))) giveBack(to);
      moved = null;
    }
    working = false;
    remember(document.activeElement);
  };
  handle = frame(tick);
  document.addEventListener("focusin", onFocusIn, true);
  return () => {
    cancelFrame(handle);
    document.removeEventListener("focusin", onFocusIn, true);
  };
}
