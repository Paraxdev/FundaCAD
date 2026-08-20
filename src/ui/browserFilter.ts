// Narrowing the browser panel to one kind of thing.
//
// The panel renders a FLAT list of nodes (see BrowserPane.vue for why), so
// filtering is a question about which SECTION each node came from rather than a
// tree walk. The panel tags them; this decides what each filter shows.
//
// The house shape for a user setting (ui/theme.ts, icons.ts, units.ts): module
// state, a validating gate over the untrusted stored value, one `neocad.*`
// key read at load, a listener set. No Vue import, so the headless suite reaches
// it.
//
// There is deliberately no "Images" filter. This app has no reference-image or
// canvas feature, so that row would filter to nothing every time it was picked —
// a control that appears broken is worse than a control that is absent. It goes
// in when there is something for it to find.

import { readSetting } from "./storedSetting";

export type BrowserFilter = "all" | "bodies" | "planes" | "sketches";

/** Which part of the tree a node belongs to. Assigned as the panel builds its
 *  flat node list; `origin` and `planes` are separate sections that one filter
 *  happens to show together, because Origin is not a construction plane. */
export type BrowserSection = "origin" | "planes" | "palette" | "bodies" | "sketches";

export const BROWSER_FILTERS: { id: BrowserFilter; label: string }[] = [
  { id: "all", label: "All items" },
  { id: "bodies", label: "Bodies" },
  { id: "planes", label: "Planes and axes" },
  { id: "sketches", label: "Sketches" },
];

/** null = show every section. Listing the sections a filter DOES show, rather
 *  than the ones it hides, is what makes a new section default to hidden under a
 *  narrow filter instead of leaking into all of them. */
const SHOWS: Record<BrowserFilter, BrowserSection[] | null> = {
  all: null,
  // The palette rides with the bodies: it only renders when bodies exist, and
  // it is the surface for their colours.
  bodies: ["palette", "bodies"],
  planes: ["origin", "planes"],
  sketches: ["sketches"],
};

export function sectionVisible(filter: BrowserFilter, section: BrowserSection): boolean {
  const shown = SHOWS[filter];
  return shown === null || shown.includes(section);
}

const KEY = "neocad.browserFilter";
const LEGACY_KEY = "sindricad.browserFilter";

export function asBrowserFilter(v: unknown): BrowserFilter | null {
  return BROWSER_FILTERS.some((f) => f.id === v) ? (v as BrowserFilter) : null;
}

function readStored(): BrowserFilter {
  const raw = readSetting(KEY, LEGACY_KEY);
  return asBrowserFilter(raw) ?? "all";
}

let active = readStored();
const listeners = new Set<() => void>();

export function getBrowserFilter(): BrowserFilter {
  return active;
}

export function setBrowserFilter(id: BrowserFilter): void {
  const next = asBrowserFilter(id);
  if (!next || next === active) return;
  active = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode / no storage: the choice just doesn't survive the session */
  }
  for (const fn of listeners) fn();
}

/** Subscribe to changes; returns the unsubscribe. */
export function onBrowserFilterChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
