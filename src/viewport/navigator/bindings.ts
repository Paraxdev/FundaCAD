// Which mouse button, with which modifiers, orbits, pans, zooms or opens the
// menu. One table is active: the default below, or the one a plugin holding the
// input.remap grant contributed (plugins/contrib.ts). Selection is not in it,
// the left button alone always selects, so a left binding needs a modifier.

export type PointerButton = "left" | "middle" | "right";
export type PointerDrag = "orbit" | "pan" | "zoom" | "gesture";

export interface PointerBinding {
  button: PointerButton;
  /** true: must be held, false: must not be, absent: either. */
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  /** What dragging does. "gesture" starts once the pointer has travelled, and
   *  hands the press to the contributor (a radial menu, say). */
  drag?: PointerDrag;
  /** A release without travel opens the context menu. */
  click?: "menu";
}

export interface PointerGesture {
  /** Client coordinates of the press. */
  x: number;
  y: number;
  pointerId: number;
  button: PointerButton;
}

export const DEFAULT_BINDINGS: readonly PointerBinding[] = [
  { button: "right", shift: true, drag: "pan", click: "menu" },
  { button: "right", drag: "orbit", click: "menu" },
  { button: "middle", drag: "pan" },
];

const BUTTONS: Record<number, PointerButton> = { 0: "left", 1: "middle", 2: "right" };
const MODS = ["shift", "ctrl", "alt"] as const;

export interface ModifierState {
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
}

export function buttonName(button: number): PointerButton | null {
  return BUTTONS[button] ?? null;
}

/** The first row that matches a press, or null. Cmd counts as Ctrl. */
export function resolvePointer(table: readonly PointerBinding[], e: ModifierState): PointerBinding | null {
  const button = buttonName(e.button);
  if (!button) return null;
  const held = { shift: e.shiftKey, ctrl: e.ctrlKey || !!e.metaKey, alt: e.altKey };
  return table.find((b) => b.button === button && MODS.every((m) => b[m] === undefined || b[m] === held[m])) ?? null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Shift+right", "Alt+left", "Middle". */
export function bindingKeys(b: PointerBinding): string {
  const mods = MODS.filter((m) => b[m] === true).map(cap);
  return [...mods, mods.length ? b.button : cap(b.button)].join("+");
}

const ACTION_NAMES: Record<PointerDrag | "menu", string> = {
  orbit: "orbit",
  pan: "pan",
  zoom: "zoom",
  gesture: "the radial menu",
  menu: "the context menu",
};

/** Every reason a table cannot be used, as sentences. Empty when it can. */
export function validateBindings(table: readonly PointerBinding[]): string[] {
  const out: string[] = [];
  table.forEach((b, j) => {
    if (!Object.values(BUTTONS).includes(b.button)) {
      out.push(`"${String(b.button)}" is not a mouse button`);
      return;
    }
    if (!b.drag && !b.click) out.push(`${bindingKeys(b)} is bound to nothing`);
    if (b.button === "left" && !MODS.some((m) => b[m] === true)) {
      out.push(`${bindingKeys(b)} is selection and cannot be rebound, hold Shift, Ctrl or Alt with it`);
    }
    for (let i = 0; i < j; i++) {
      const a = table[i]!;
      if (a.button !== b.button || !MODS.every((m) => a[m] === undefined || a[m] === b[m])) continue;
      const what = (x: PointerBinding) => [x.drag, x.click].filter(Boolean).map((k) => ACTION_NAMES[k!]).join(" and ");
      out.push(`${bindingKeys(b)} is bound twice, to ${what(a)} and to ${what(b)}, and only the first applies`);
      break;
    }
  });
  if (!table.some((b) => b.drag === "orbit")) out.push("No button orbits the view");
  return out;
}

/** The ? sheet's mouse rows for a table. */
export function bindingRows(table: readonly PointerBinding[]): { key: string; label: string }[] {
  const rows: { key: string; label: string }[] = [];
  for (const b of table) if (b.drag) rows.push({ key: `${bindingKeys(b)} drag`, label: cap(ACTION_NAMES[b.drag]) });
  // One menu row per button, the plainest way to click it.
  const held = (b: PointerBinding) => MODS.filter((m) => b[m] === true).length;
  const menus = new Map<PointerButton, PointerBinding>();
  for (const b of table) {
    const had = menus.get(b.button);
    if (b.click && (!had || held(b) < held(had))) menus.set(b.button, b);
  }
  for (const b of menus.values()) rows.push({ key: `${bindingKeys(b)} click`, label: cap(ACTION_NAMES[b.click!]) });
  return rows;
}

// --- the active table -----------------------------------------------------------

let active: readonly PointerBinding[] = DEFAULT_BINDINGS;
let gestureHandler: ((g: PointerGesture) => void) | null = null;
let leftHeld: () => boolean = () => false;
const listeners = new Set<() => void>();

/** Replace the table; null restores the default. Throws on a table that
 *  validateBindings refuses, so a broken preset never half applies. */
export function setPointerBindings(table: readonly PointerBinding[] | null, onGesture?: (g: PointerGesture) => void) {
  if (table) {
    const bad = validateBindings(table);
    if (bad.length) throw new Error(`Mouse bindings refused: ${bad.join("; ")}`);
  }
  active = table ? [...table] : DEFAULT_BINDINGS;
  gestureHandler = table ? onGesture ?? null : null;
  for (const fn of listeners) fn();
}

export function pointerBindings(): readonly PointerBinding[] {
  return active;
}

export function onPointerBindingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function startPointerGesture(g: PointerGesture): boolean {
  if (!gestureHandler) return false;
  gestureHandler(g);
  return true;
}

/** The app says when a tool owns the left button, Alt+drags included (sketch
 *  patterns, the datum pose), so a modifier+left binding steps aside then. */
export function setLeftButtonOwner(fn: () => boolean) {
  leftHeld = fn;
}

export function leftButtonOwned(): boolean {
  try {
    return leftHeld();
  } catch {
    return false;
  }
}
