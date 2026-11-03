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

const onPage = (a: Element | null) => a === null || a === document.body || a === document.documentElement;

/** A tool's own box takes focus and drops it on the page when it goes, where the next key runs a shortcut and Tab starts
 *  over. A keyboard user's focus from before the tool goes back then, to the list's tab stop if a build replaced the
 *  row. Pointer focus is left alone. A sketch started from a list takes focus to the 3D view, or its keys would type
 *  ahead in the list. Frames, as restoreWhenIdle, since no tool says when it starts or ends. */
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
  let seen: Element | null = null;
  let from: { el: HTMLElement; list: Element | null } | null = null;
  let handle = 0;

  function giveBack(to: { el: HTMLElement; list: Element | null }) {
    const stop = to.list?.isConnected ? to.list.querySelector<HTMLElement>('[tabindex="0"]') : null;
    const target = to.el.isConnected ? to.el : stop;
    if (target && !target.closest("[inert], [hidden]")) target.focus();
  }

  const tick = () => {
    if (e.sketch.active && !sketching) {
      const a = document.activeElement;
      if (a && !onPage(a) && typesAhead(a)) e.viewport.domElement.focus({ preventScroll: true });
    }
    sketching = e.sketch.active;
    const now = e.toolAtWork();
    if (!now) {
      if (working && from && onPage(document.activeElement)) giveBack(from);
      const a = document.activeElement;
      if (a !== seen && !a?.closest(PASSING)) {
        seen = a;
        from = a instanceof HTMLElement && !onPage(a) && shown(a) ? { el: a, list: a.closest(LISTS) } : null;
      }
    }
    working = now;
    handle = frame(tick);
  };
  handle = frame(tick);
  return () => cancelFrame(handle);
}
