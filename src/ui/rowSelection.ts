// Click-to-select over a list of rows, the way every file manager does it.
//
// A plain click selects one row, Ctrl (Cmd) adds or removes one, Shift takes the
// run from the last plainly or Ctrl-clicked row (the anchor) to this one, and
// Ctrl+Shift adds that run to what is already selected. The Browser's bodies
// and sketches both select this way, and before this each list that wanted more
// than one row wrote its own copy of the rules.
//
// Deliberately only the RULES. What a selection is FOR differs by list: a body
// selection lives in the viewport and lights up in 3D, a sketch selection drives
// the timeline and the inspector. So this holds no state and draws nothing, the
// caller keeps the state wherever that list already keeps it and renders its own
// rows. Generic over the key so it serves an id string or anything else, and
// Vue-free so the headless suite reaches it.

/** What was held during the click. */
export interface SelectMods {
  /** Ctrl or Cmd: add or remove this one row. */
  toggle: boolean;
  /** Shift: take the run from the anchor to this row. */
  range: boolean;
}

/** A selection and the row a Shift-click measures its run from. */
export interface RowSelection<K> {
  readonly keys: readonly K[];
  readonly anchor: K | null;
}

export const EMPTY_SELECTION: RowSelection<never> = { keys: [], anchor: null };

/** The modifiers off a mouse event. Cmd counts as Ctrl, as it does everywhere
 *  else in the app. */
export function modsOf(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): SelectMods {
  return { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey };
}

/** The selection after clicking `key`. `order` is the rows as they are drawn
 *  right now, which is what a run means: rows inside a collapsed folder are not
 *  on screen, so a Shift-click does not reach into it.
 *
 *  A Shift-click with no usable anchor (none yet, or its row is no longer drawn)
 *  selects just the clicked row and makes it the anchor, rather than guessing
 *  where a run should start. A Shift-click never moves the anchor, which is what
 *  lets a second Shift-click grow or shrink the same run. */
export function selectRow<K>(
  sel: RowSelection<K>,
  order: readonly K[],
  key: K,
  mods: SelectMods,
): RowSelection<K> {
  if (mods.range) {
    const from = sel.anchor === null ? -1 : order.indexOf(sel.anchor);
    const to = order.indexOf(key);
    if (from < 0 || to < 0) return { keys: [key], anchor: key };
    const run = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    if (!mods.toggle) return { keys: run, anchor: sel.anchor };
    const merged = [...sel.keys];
    for (const k of run) if (!merged.includes(k)) merged.push(k);
    return { keys: merged, anchor: sel.anchor };
  }
  if (mods.toggle) {
    const keys = sel.keys.includes(key) ? sel.keys.filter((k) => k !== key) : [...sel.keys, key];
    return { keys, anchor: key };
  }
  return { keys: [key], anchor: key };
}

/** The rows one gesture on `key` acts on: the whole selection when the row that
 *  was grabbed is part of it, otherwise just that row. A menu that silently acted
 *  on one row of a selection of two hundred would be worse than no menu. */
export function actOn<K>(selected: readonly K[], key: K): K[] {
  return selected.includes(key) ? [...selected] : [key];
}
