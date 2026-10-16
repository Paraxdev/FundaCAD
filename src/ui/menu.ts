// A small menu-bar with dropdown menus (File, …). Each menu is a button that
// opens a popup of items; clicking an item runs it and closes the popup, and
// clicking anywhere else closes it. Disabled items are skipped.
//
// The right-click context menu that used to live at the bottom of this file is
// now stores/contextMenu.ts + components/overlays/ContextMenuHost.vue.
// `contextMenu(x, y, items)` and `dismissContextMenu()` keep their signatures,
// so browserTree, timeline, sketchMode, contextMenus.ts and the ViewCube are
// bit-identical at their call sites.
import { useContextMenuStore, type CtxItem } from "../stores/contextMenu";
import { useRadialMenuStore } from "../stores/radialMenu";
import { RadialSession, pickRadial, type RadialTrigger } from "./radialMenu";
import { claimEscape } from "./escapeClaim";

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

// The Menubar class that used to live here is
// components/shell/MenuBar.vue. MenuItem/MenuDef above are still the contract
// app/menubarDef.ts builds against, and the disabled()/checked() thunks still
// mean "re-evaluate every time the menu opens", the component does that with a
// tick ref instead of walking the popup's DOM and poking attributes.

export type { CtxItem };

/** Close the open context menu (if any). For tool/mode exits, normal dismissal
 *  (outside pointerdown, Escape, item click) is handled by the menu itself. */
export function dismissContextMenu(): void {
  useContextMenuStore().close();
}

/** Pop a right-click context menu at (x,y) with the given items. Closes on an
 *  outside pointerdown or Escape. One shared engine for every right-click
 *  surface (viewport, timeline, browser tree, sketch mode, ViewCube).
 *
 *  Opening replaces whatever was open, which is the same semantics the old
 *  module-level `activeClose` singleton had. */
export function contextMenu(x: number, y: number, items: CtxItem[]): void {
  useContextMenuStore().show(x, y, items);
}

export interface MenuAtOptions {
  /** "list" is the right-click menu; "radial" a ring around the point. */
  style?: "list" | "radial";
  /** The pointer or key that opened it is still held: moving picks and the
   *  release runs what it points at. Radial only. */
  gesture?: RadialTrigger;
}

let radial: RadialSession | null = null;

/** Open a menu at a point, as a list or a ring. Opening replaces whatever menu
 *  was open. Items, icons, one level of children in the list and any depth in
 *  the ring. */
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

/** Close a radial menu opened by openMenuAt, if one is up. */
export function dismissRadialMenu(): void {
  radial?.close();
}
