// The panel renders a flat node list, so a filter picks which sections show rather than walking a tree.
// No "Images" filter: the app has no reference image feature, and a filter that always shows nothing looks broken.

import { readSetting } from "./storedSetting";

export type BrowserFilter = "all" | "bodies" | "planes" | "sketches";

/** `origin` and `planes` are separate sections one filter shows together, since Origin is not a construction plane. */
export type BrowserSection = "origin" | "planes" | "palette" | "bodies" | "sketches";

export const BROWSER_FILTERS: { id: BrowserFilter; label: string }[] = [
  { id: "all", label: "All items" },
  { id: "bodies", label: "Bodies" },
  { id: "planes", label: "Planes and axes" },
  { id: "sketches", label: "Sketches" },
];

/** null shows every section. Listing what a filter shows, not what it hides, keeps a new section hidden by default. */
const SHOWS: Record<BrowserFilter, BrowserSection[] | null> = {
  all: null,
  // The palette only renders with bodies and colours them, so it rides with them.
  bodies: ["palette", "bodies"],
  planes: ["origin", "planes"],
  sketches: ["sketches"],
};

export function sectionVisible(filter: BrowserFilter, section: BrowserSection): boolean {
  const shown = SHOWS[filter];
  return shown === null || shown.includes(section);
}

const KEY = "fundacad.browserFilter";
const LEGACY_KEYS = ["neocad.browserFilter", "sindricad.browserFilter"];

/** For a plugin section, which arrives unchecked: a name this build lacks is always shown, never hidden. */
export function isBrowserSection(v: string): v is BrowserSection {
  return v === "origin" || v === "planes" || v === "palette" || v === "bodies" || v === "sketches";
}

export function asBrowserFilter(v: unknown): BrowserFilter | null {
  return BROWSER_FILTERS.some((f) => f.id === v) ? (v as BrowserFilter) : null;
}

function readStored(): BrowserFilter {
  const raw = readSetting(KEY, ...LEGACY_KEYS);
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

export function onBrowserFilterChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
