import { buildMenubar } from "../../src/app/menubarDef";
import { menuName, type MenuDef, type MenuItem } from "../../src/ui/menu";
import type { Engine } from "../../src/app/engine";

export const itemText = (i: MenuItem): string => (typeof i.label === "function" ? i.label() : i.label);
export const rowName = (i: MenuItem): string => i.refName ?? itemText(i);

export const buildMenus = (engine: Partial<Engine> = {}): MenuDef[] =>
  buildMenubar({ ui: { home: { open: () => {} } }, ...engine } as unknown as Engine);

export const menuOf = (name: string, menus: MenuDef[] = buildMenus()): MenuDef =>
  menus.find((m) => menuName(m) === name)!;

/** A row found by its stable name, English whatever the language. */
export const row = (menu: string, name: string, menus?: MenuDef[]): MenuItem =>
  menuOf(menu, menus).items.find((i) => !i.separator && rowName(i) === name)!;

// A range keeps the Undo and Redo rows, which read the document, out of a test that has none.
export const texts = (m: MenuDef, from = 0, to?: number): string[] =>
  m.items.slice(from, to).map((i) => (i.separator ? "---" : itemText(i)));
export const names = (m: MenuDef, from = 0, to?: number): string[] =>
  m.items.slice(from, to).map((i) => (i.separator ? "---" : rowName(i)));
