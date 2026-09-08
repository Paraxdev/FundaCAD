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
