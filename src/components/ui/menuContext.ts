import type { ComputedRef, InjectionKey, Ref } from "vue";

/** What a MenuItem tells the Menu it sits in. */
export interface MenuEntry {
  el: () => HTMLElement | null;
  disabled: () => boolean;
  label: () => string;
  checkable: () => boolean;
  hasSub: () => boolean;
  select: () => void;
}

export interface MenuContext {
  register: (entry: MenuEntry) => () => void;
  hasChecks: ComputedRef<boolean>;
  tabindex: (entry: MenuEntry) => 0 | -1;
  onItemFocus: (entry: MenuEntry) => void;
  /** The item whose submenu is open, one per level. */
  openItem: Ref<MenuEntry | null>;
  /** Whether that submenu takes focus on its first item: a key opened it, not the pointer. */
  subFocus: Ref<boolean>;
  activate: (entry: MenuEntry) => void;
  openSub: (entry: MenuEntry, focus: boolean) => void;
  closeSub: () => void;
  hoverItem: (entry: MenuEntry) => void;
  cancelSubClose: () => void;
  /** Closes the whole tree from any level. */
  closeAll: () => void;
  /** Adds a submenu's element to the tree, so a press in it is not outside. */
  addTreeEl: (el: HTMLElement) => () => void;
}

export const MENU: InjectionKey<MenuContext> = Symbol("menu");
