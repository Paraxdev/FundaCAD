// Where the shell's big surfaces sit: the ribbon along the top or down the side,
// the history strip along the bottom or up the right.
//
// The house shape for a user setting (ui/theme.ts, icons.ts, units.ts,
// toolRail.ts): module state, a validating gate over the untrusted stored value,
// one `fundacad.*` key read at load, and a listener set so live surfaces
// re-render. No Vue import — that is what keeps the headless *.test.ts suite
// able to reach it.
//
// A MAP like toolRail's rather than one value, so it sanitises PER FIELD: a
// stored object with a garbage `ribbon` must not cost the user their `history`
// choice as well.
//
// These are positions, not layouts. Nothing here re-parents anything: the
// components keep their element ids, because every rule in styles/_layout.scss
// is id-scoped to them and the e2e suite selects on them. What changes is a
// modifier attribute on the shell, and CSS does the rest.

import { readSetting } from "./storedSetting";

export type RibbonSide = "top" | "left";
export type HistorySide = "bottom" | "right";

export interface LayoutPrefs {
  ribbon: RibbonSide;
  history: HistorySide;
}

/** What the stylesheet already expresses with no attribute at all, so the
 *  defaults cost nothing to render and a failure here degrades to them. */
export const DEFAULT_LAYOUT: LayoutPrefs = { ribbon: "top", history: "bottom" };

const RIBBON_SIDES: RibbonSide[] = ["top", "left"];
const HISTORY_SIDES: HistorySide[] = ["bottom", "right"];

const KEY = "fundacad.layout";
const LEGACY_KEYS = ["neocad.layout", "sindricad.layout"];

export function asRibbonSide(v: unknown): RibbonSide | null {
  return RIBBON_SIDES.includes(v as RibbonSide) ? (v as RibbonSide) : null;
}

export function asHistorySide(v: unknown): HistorySide | null {
  return HISTORY_SIDES.includes(v as HistorySide) ? (v as HistorySide) : null;
}

/** Narrow untrusted JSON to a complete LayoutPrefs, field by field. Anything
 *  unreadable falls back to that field's default and takes nothing else with
 *  it. */
export function asLayoutPrefs(v: unknown): LayoutPrefs {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...DEFAULT_LAYOUT };
  const o = v as Record<string, unknown>;
  return {
    ribbon: asRibbonSide(o["ribbon"]) ?? DEFAULT_LAYOUT.ribbon,
    history: asHistorySide(o["history"]) ?? DEFAULT_LAYOUT.history,
  };
}

function readStored(): LayoutPrefs {
  try {
    const raw = readSetting(KEY, ...LEGACY_KEYS);
    return raw ? asLayoutPrefs(JSON.parse(raw)) : { ...DEFAULT_LAYOUT };
  } catch {
    // Unparseable JSON is treated as no setting at all: the shell opens in its
    // default arrangement rather than failing to render.
    return { ...DEFAULT_LAYOUT };
  }
}

let current = readStored();
const listeners = new Set<() => void>();

/** Read-only — go through setLayoutPref so the write is persisted and
 *  subscribers are told. */
export function layoutPrefs(): Readonly<LayoutPrefs> {
  return current;
}

export function setLayoutPref<K extends keyof LayoutPrefs>(key: K, value: LayoutPrefs[K]): void {
  const ok = key === "ribbon" ? asRibbonSide(value) : asHistorySide(value);
  if (!ok || current[key] === value) return;
  // A fresh object rather than a mutation, so a subscriber may hold the result
  // of layoutPrefs() and compare identity to decide it must redraw.
  current = { ...current, [key]: value };
  apply();
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode / no storage: the choice just doesn't survive the session */
  }
  for (const fn of listeners) fn();
}

/** Subscribe to changes; returns the unsubscribe. */
export function onLayoutPrefsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Stamp the non-default positions on <html>, so the stylesheet can answer with
 *  plain attribute selectors and the default arrangement needs no attribute at
 *  all — the same trick theme.ts uses for the palette that lives on bare :root,
 *  and for the same reason: a `[data-ribbon="top"]` block would be a duplicate
 *  of the base rules and the two would drift. */
function apply() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [key, attr] of [["ribbon", "data-ribbon"], ["history", "data-history"]] as const) {
    const value = current[key];
    if (value === DEFAULT_LAYOUT[key]) root.removeAttribute(attr);
    else root.setAttribute(attr, value);
  }
}

/** Put the stored arrangement on the document. Call once at startup, alongside
 *  initTheme — reading the value at module load does not write the attributes,
 *  so without this a stored side-ribbon would open along the top until the user
 *  changed something. */
export function initLayoutPrefs() {
  apply();
}
