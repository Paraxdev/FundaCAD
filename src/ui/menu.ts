// Menu item types that app/menubarDef.ts builds against (rendered by components/shell/MenuBar.vue), and the shared
// context menu entry points backed by stores/contextMenu.ts.
import { useContextMenuStore, type CtxItem } from "../stores/contextMenu";
import { useRadialMenuStore } from "../stores/radialMenu";
import { RadialSession, pickRadial, type RadialTrigger } from "./radialMenu";
import { claimEscape } from "./escapeClaim";
import { isMenuKey } from "./focus";

export interface MenuItem {
  label: string;
  shortcut?: string; // display hint, e.g. "Ctrl+S"
  onClick?: () => void;
  separator?: boolean;
  disabled?: () => boolean;
  /** Toggle state, a check icon in the menu's reserved gutter when true.
   *  A thunk, so it is re-evaluated each time the menu opens. */
  checked?: () => boolean;
}

export interface MenuDef {
  label: string;
  items: MenuItem[];
}

export type { CtxItem };

/** For tool and mode exits; ordinary dismissal is handled by the menu itself. */
export function dismissContextMenu(): void {
  useContextMenuStore().close();
}

/** One shared engine for every right-click surface. Closes on an outside pointerdown or Escape, and opening replaces
 *  whatever was open. */
export function contextMenu(x: number, y: number, items: CtxItem[]): void {
  useContextMenuStore().show(x, y, items);
}

// On document in the bubble phase, so the focused menu has had the key first. Escape is the menu's own, in capture.
function keepMenuKeys(e: KeyboardEvent): void {
  if (isMenuKey(e)) e.stopPropagation();
}

let keyGuards = 0;

/** While a menu holds focus, the keys it moves and types ahead with stop short of the window's shortcuts, where an arrow
 *  turns the view and a letter starts a tool. Ctrl, Alt and Meta combos, Delete and the F keys still pass. */
export function guardMenuKeys(): () => void {
  if (keyGuards++ === 0) document.addEventListener("keydown", keepMenuKeys);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--keyGuards === 0) document.removeEventListener("keydown", keepMenuKeys);
  };
}

export interface MenuAtOptions {
  /** "list" is the right-click menu; "radial" a ring around the point. */
  style?: "list" | "radial";
  /** The pointer or key that opened it is still held: moving picks and the
   *  release runs what it points at. Radial only. */
  gesture?: RadialTrigger;
}

let radial: RadialSession | null = null;

/** Opening replaces whatever menu was open. One level of children in the list, any depth in the ring. */
export function openMenuAt(x: number, y: number, items: CtxItem[], opts: MenuAtOptions = {}): void {
  radial?.close();
  if ((opts.style ?? "list") === "list") {
    contextMenu(x, y, items);
    return;
  }
  dismissContextMenu();
  const store = useRadialMenuStore();
  let last = { x, y };
  let releaseEscape: (() => void) | null = claimEscape();
  const s: RadialSession = new RadialSession(x, y, items, opts.gesture ?? null, (st) => {
    store.set(st);
    if (!st) stop();
  });
  radial = s;
  const isTrigger = (e: PointerEvent) => {
    const g = s.state.gesture;
    return !!g && "pointerId" in g && g.pointerId === e.pointerId;
  };
  const onMove = (e: PointerEvent) => {
    last = { x: e.clientX, y: e.clientY };
    s.move(e.clientX, e.clientY);
  };
  const onUp = (e: PointerEvent) => {
    if (isTrigger(e)) s.release(e.clientX, e.clientY);
  };
  const onDown = (e: PointerEvent) => {
    if (s.state.gesture) return;
    if (pickRadial(s.state.items.length, e.clientX - s.state.x, e.clientY - s.state.y) !== null) {
      e.stopPropagation();
      e.preventDefault();
    }
    s.click(e.clientX, e.clientY);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    s.close();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const g = s.state.gesture;
    if (g && "key" in g && e.key.toLowerCase() === g.key.toLowerCase()) s.release(last.x, last.y);
  };
  const onBlur = () => s.close();
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  function stop() {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
    releaseEscape?.();
    releaseEscape = null;
    if (radial === s) radial = null;
  }
}

export function radialMenuOpen(): boolean {
  return radial !== null;
}

/** Close a radial menu opened by openMenuAt, if one is up. */
export function dismissRadialMenu(): void {
  radial?.close();
}
