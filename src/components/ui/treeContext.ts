import type { InjectionKey } from "vue";

/** One row of a Tree, in the order the rows are drawn. A child follows its parent, one level deeper. */
export interface TreeMeta {
  key: string;
  /** 1 for a top row. */
  level: number;
  expandable?: boolean | undefined;
  expanded?: boolean | undefined;
  disabled?: boolean | undefined;
  /** The text type-ahead matches. */
  label?: string | undefined;
}

export interface TreeSlot {
  level: number;
  posinset: number;
  setsize: number;
  expandable: boolean;
  expanded: boolean;
  disabled: boolean;
}

export interface TreeContext {
  slot: (key: string) => TreeSlot | undefined;
  tabindex: (key: string) => 0 | -1;
  onItemFocus: (key: string) => void;
}

export const TREE: InjectionKey<TreeContext> = Symbol("tree");

export const TREE_ITEM_SELECTOR = "[data-tree-item]";

/** Shift+F10 everywhere, and the Menu key on Windows and Linux keyboards. */
export function isMenuKeyEvent(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey === true);
}

/** Level, position and set size of each row, from the flat list. */
export function treeSlots(items: readonly TreeMeta[]): Map<string, TreeSlot> {
  const parent: number[] = [];
  const stack: number[] = [];
  const size = new Map<number, number>();
  const pos: number[] = [];
  items.forEach((it, i) => {
    while (stack.length && items[stack[stack.length - 1]!]!.level >= it.level) stack.pop();
    const p = stack.length ? stack[stack.length - 1]! : -1;
    parent[i] = p;
    pos[i] = (size.get(p) ?? 0) + 1;
    size.set(p, pos[i]!);
    stack.push(i);
  });
  const out = new Map<string, TreeSlot>();
  items.forEach((it, i) =>
    out.set(it.key, {
      level: it.level,
      posinset: pos[i]!,
      setsize: size.get(parent[i]!) ?? 1,
      expandable: !!it.expandable,
      expanded: !!it.expandable && !!it.expanded,
      disabled: !!it.disabled,
    }),
  );
  return out;
}

/** The row a type-ahead `text` lands on: the next enabled row after `from` whose label starts with it. One letter
 *  typed again and again steps through the rows it starts. */
export function typeAheadIndex(items: readonly TreeMeta[], from: number, text: string): number {
  const n = items.length;
  const typed = text.toLowerCase();
  const repeat = [...typed].every((c) => c === typed[0]);
  const q = repeat ? typed.slice(0, 1) : typed;
  const start = repeat || from < 0 ? from + 1 : from;
  for (let k = 0; k < n; k++) {
    const it = items[(start + k) % n]!;
    if (!it.disabled && it.label?.toLowerCase().startsWith(q)) return (start + k) % n;
  }
  return -1;
}
