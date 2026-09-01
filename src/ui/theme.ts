// The active theme, as a user setting.
//
// A theme here is a palette and nothing else — the proportions (radii, the
// spacing scale, easing, durations) are shared across all of them, so switching
// is a repaint and never a relayout. The palettes themselves live in
// styles/_themes.scss; this file only decides which one is on, remembers it, and
// tells anyone who has to react.
//
// Deliberately the same shape as ui/iconPacks (registry, narrow-an-untrusted-id,
// localStorage, listener set): the two settings behave identically from the
// user's side, and a second mechanism for the same job is a second thing to keep
// in step.
//
// The DOM side is one attribute. CSS does the rest, because a theme block is the
// same custom properties at a higher specificity — which also means the app is
// already themed before this module runs, and a failure here degrades to the
// default palette rather than to an unstyled page.

import { readSetting } from "./storedSetting";

export interface Theme {
  id: string;
  label: string;
  /** For the settings UI: is this a light or dark palette? Not used for styling
   *  — `color-scheme` in the theme block does that — but a picker wants to group
   *  them, and guessing from the id would break the moment one is renamed. */
  mode: "dark" | "light";
}

/** Every theme with a block in styles/_themes.scss. Keep the two in step: an id
 *  listed here without a block applies an attribute that matches no rule and so
 *  silently leaves the previous palette on screen. */
export const THEMES: Theme[] = [
  { id: "apollo", label: "Apollo", mode: "dark" },
  { id: "concrete", label: "Concrete", mode: "dark" },
  { id: "forge", label: "Forge", mode: "dark" },
  { id: "slate", label: "Slate", mode: "dark" },
  { id: "moss", label: "Moss", mode: "dark" },
  { id: "paper", label: "Paper", mode: "light" },
];

/** The palette on :root, so it needs no attribute and survives a cold load with
 *  no script. */
export const DEFAULT_THEME_ID = "apollo";

const KEY = "fundacad.theme";
const LEGACY_KEYS = ["neocad.theme", "sindricad.theme"];

/** Narrow an untrusted string — a stored setting, a `<select>` value, a URL
 *  parameter — to a known theme id, or null. Every boundary that can set the
 *  theme goes through here: an unknown id would stamp an attribute nothing
 *  matches, leaving whatever was on screen before, which looks exactly like the
 *  setting not working rather than like a rejected value. */
export function asThemeId(v: unknown): string | null {
  return typeof v === "string" && THEMES.some((t) => t.id === v) ? v : null;
}

function readStored(): string {
  return asThemeId(readSetting(KEY, ...LEGACY_KEYS)) ?? DEFAULT_THEME_ID;
}

let activeId = readStored();
const listeners = new Set<() => void>();

export function getTheme(): string {
  return activeId;
}

export function themeMode(id: string = activeId): "dark" | "light" {
  return THEMES.find((t) => t.id === id)?.mode ?? "dark";
}

/** Write the attribute. The default theme lives on bare `:root`, so it is
 *  expressed by REMOVING the attribute rather than by setting it — otherwise
 *  `[data-theme="forge"]` would have to exist as a duplicate of :root, and the
 *  two would drift. */
function apply(id: string) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (id === DEFAULT_THEME_ID) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", id);
}

export function setTheme(id: string) {
  const next = asThemeId(id);
  if (!next || next === activeId) return;
  activeId = next;
  apply(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode / no storage: the choice just doesn't survive the session */
  }
  for (const fn of listeners) fn();
}

/** Subscribe to theme changes; returns the unsubscribe.
 *
 *  CSS needs no subscriber — it re-cascades on its own. This exists for the
 *  parts that CANNOT: the Three.js viewport, whose materials hold resolved
 *  numbers rather than references to a custom property (see
 *  viewport/themeColors.ts). */
export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Put the stored theme on the document. Call once at startup.
 *
 *  Needed even though `activeId` is read at module load, because reading it does
 *  not write the attribute — and a stored non-default theme would otherwise show
 *  the default palette until the user changed something. */
export function initTheme() {
  apply(activeId);
}
