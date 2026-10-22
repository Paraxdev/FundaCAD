// File manager style row selection: click, Ctrl to toggle, Shift for a run from the anchor, Ctrl+Shift to add a run.
// Only the rules, no state: each list keeps its selection where it already does.

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

/** `order` is the rows as drawn now, so a run never reaches into a collapsed folder. A Shift-click with no usable
 *  anchor selects just this row and anchors it; a Shift-click never moves the anchor, so a run can grow or shrink. */
export function selectRow<K>(sel: RowSelection<K>, order: readonly K[], key: K, mods: SelectMods): RowSelection<K> {
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

/** The selection after clicking a folder that holds `members`. A plain click
 *  takes exactly them; Ctrl or Shift adds them, or takes them out again when all
 *  of them were already in. */
export function selectGroup<K>(selected: readonly K[], members: readonly K[], mods: SelectMods): K[] {
  if (!mods.toggle && !mods.range) return [...members];
  const have = new Set(selected);
  if (members.length && members.every((k) => have.has(k))) {
    const drop = new Set(members);
    return selected.filter((k) => !drop.has(k));
  }
  const out = [...selected];
  for (const k of members) if (!have.has(k)) out.push(k);
  return out;
}

/** The whole selection when the grabbed row is in it, else just that row. */
export function actOn<K>(selected: readonly K[], key: K): K[] {
  return selected.includes(key) ? [...selected] : [key];
}
