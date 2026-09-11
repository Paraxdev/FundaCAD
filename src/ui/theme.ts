// The active theme, as a user setting.
//
// There used to be a fixed roster of six palettes and a picker to choose among
// them. There is one BUILT-IN palette now, the brutalist graphite in
// styles/_tokens.scss, and everything else is a palette the user UPLOADS: a
// small file of colour tokens, stored in the app's prefs, layered over the
// built-in one at runtime. So this module's job changed from "which of six is
// on" to "the built-in one, or one the user brought", and the roster is no
// longer a constant, it grows and shrinks as the user adds and removes files.
//
// A theme is still a palette and nothing else. The proportions (radii, spacing,
// easing, durations) are shared and fixed in _tokens.scss, so a theme, built-in
// or uploaded, is a repaint and never a relayout, and an uploaded file that
// tried to move a layout has nowhere to say so: only colour tokens are read.
//
// Two DOM strategies, one per kind, and the split matters. The built-in palette
// is bare :root in the stylesheet, so "the built-in theme" is expressed by
// having NOTHING extra on the document, which means the app is correctly themed
// before this module runs and a failure here degrades to the built-in look
// rather than to an unstyled page. An uploaded palette is written as inline
// custom properties on the document element, which outranks any stylesheet rule
// regardless of source order (the one hazard a [data-theme] block would have
// had) and is trivially removed token by token when the user switches away.
//
// Deliberately the same shape as ui/iconPacks for the parts that stayed
// (listener set, narrow-an-untrusted-id, localStorage): a second mechanism for
// the same job is a second thing to keep in step.

import { readSetting } from "./storedSetting";

export interface Theme {
  id: string;
  label: string;
  /** For the settings UI: is this a light or dark palette? Not used for
   *  styling, `color-scheme` does that, but a picker wants to group them. An
   *  uploaded theme declares its own; the built-in one is dark. */
  mode: "dark" | "light";
  /** True for a palette the user uploaded, false for the built-in one. The
   *  picker uses it to decide whether a "remove" action applies: the built-in
   *  theme cannot be deleted, an uploaded one can. */
  custom: boolean;
}

/** A palette the user uploaded: a validated map of colour tokens plus the label
 *  and mode shown in the picker. `palette` only ever holds whitelisted token
 *  names with values that parse as colours, both enforced in `parseCustomTheme`
 *  before anything is stored, so applying one is a straight write with no
 *  further checking. */
export interface CustomTheme extends Theme {
  custom: true;
  palette: Record<string, string>;
}

/** The one palette that ships. Lives on bare :root in _tokens.scss, so it needs
 *  no attribute, no inline property and no script, and survives a cold load
 *  with the stylesheet alone. */
export const BUILTIN_THEME: Theme = { id: "fundacad", label: "FundaCAD Noir", mode: "dark", custom: false };

/** The built-in theme's id, the value the setting falls back to whenever a
 *  stored id names nothing that currently exists (an uploaded theme that was
 *  since removed, a palette from an older build, a legacy key). */
export const DEFAULT_THEME_ID = BUILTIN_THEME.id;

const KEY = "fundacad.theme";
const LEGACY_KEYS = ["neocad.theme", "sindricad.theme"];
/** Where the uploaded palettes themselves live, as one JSON array. Separate
 *  from KEY (which only holds the active id) so switching themes never rewrites
 *  the library, and removing a theme never disturbs the pointer at the active
 *  one. */
const LIBRARY_KEY = "fundacad.themes";

/** The colour tokens an uploaded palette is allowed to set, exactly the palette
 *  half of _tokens.scss. NOT the shape tokens (radii, spacing, shadows, motion):
 *  those are the app's proportions and an uploaded file moving them would break
 *  the repaint-not-relayout contract the whole theme system rests on. A key
 *  outside this set is dropped on upload, so a file cannot reach a property we
 *  did not choose to expose. */
const PALETTE_TOKENS = new Set<string>([
  "--bg", "--panel", "--panel-2", "--raised", "--raised-2", "--viewport-bg",
  "--line", "--line-strong",
  "--text", "--text-dim", "--text-mute",
  "--accent", "--accent-hot", "--accent-tint", "--accent-tint-2", "--accent-glow", "--on-accent",
  "--ok", "--warn", "--error", "--error-tint",
  "--accent-blue",
]);

/** The colour shapes a token value may hold: a #hex (3/4/6/8 digits) or an
 *  rgb()/rgba() call and nothing else. Two reasons it is this strict and not
 *  "any CSS colour". First, safety: the value is handed to setProperty, which
 *  the engine would reject if malformed, but validating up front means a bad
 *  file is refused with a message at upload rather than silently doing nothing
 *  later. Second, the viewport: viewport/themeColors.parseCssColor resolves the
 *  accent for the Three side and understands exactly hex and rgb/rgba, so a
 *  palette kept inside this grammar is one a manipulator can be drawn in too,
 *  and an uploaded accent can never be a colour the chrome shows but the 3D view
 *  cannot. The character class forbids ; { } and letters (beyond the rgb/rgba
 *  keyword), so nothing here can be anything but a colour. */
const COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$|^rgba?\([0-9.,%\s/]+\)$/i;

/** Up to this many uploaded palettes. A generous cap, not a UX limit anyone is
 *  expected to reach: it only stops a script or a stuck upload loop from filling
 *  localStorage, where a single overflow throw would take out every other
 *  setting sharing the store. */
const MAX_CUSTOM = 24;

function readLibrary(): CustomTheme[] {
  if (typeof localStorage === "undefined") return [];
  let raw: string | null;
  try {
    raw = localStorage.getItem(LIBRARY_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // Re-validate on the way in, not just on the way out: the store is editable by
  // hand and by an older or newer build, so a stored entry is as untrusted as an
  // uploaded file. Anything that no longer parses is dropped rather than trusted.
  const out: CustomTheme[] = [];
  const seen = new Set<string>([BUILTIN_THEME.id]);
  for (const entry of parsed) {
    const t = coerceStored(entry);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

function writeLibrary(list: CustomTheme[]) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(list));
  } catch {
    // Full or blocked store: the in-memory library still holds this session's
    // themes, the write is what does not survive a reload.
  }
}

let library: CustomTheme[] = readLibrary();

/** Every theme the picker can offer: the built-in one first, then the uploaded
 *  palettes in the order they were added. A function, not a constant, because
 *  unlike the old six-palette roster this changes while the app runs. */
export function themes(): Theme[] {
  return [BUILTIN_THEME, ...library];
}

/** The uploaded palettes alone, for a settings surface that lists what can be
 *  removed. */
export function customThemes(): CustomTheme[] {
  return library.slice();
}

function findTheme(id: string): Theme | undefined {
  return id === BUILTIN_THEME.id ? BUILTIN_THEME : library.find((t) => t.id === id);
}

/** Narrow an untrusted string, a stored setting, a `<select>` value, to a theme
 *  id that currently exists, or null. Every boundary that can set the theme goes
 *  through here: an id naming a theme that was removed (or never existed) would
 *  otherwise try to apply a palette that is not there, which reads as the
 *  setting silently doing nothing rather than as a value being refused. */
export function asThemeId(v: unknown): string | null {
  return typeof v === "string" && findTheme(v) !== undefined ? v : null;
}

function readStored(): string {
  return asThemeId(readSetting(KEY, ...LEGACY_KEYS)) ?? DEFAULT_THEME_ID;
}

let activeId = readStored();
const listeners = new Set<() => void>();
/** The inline custom-property names currently written on the document element,
 *  so the next apply can clear exactly what the last one set, no more (a stray
 *  removeProperty on a token the built-in theme owns would be harmless, but
 *  clearing precisely keeps the DOM readable in the inspector). */
let appliedProps: string[] = [];

export function getTheme(): string {
  return activeId;
}

export function themeMode(id: string = activeId): "dark" | "light" {
  return findTheme(id)?.mode ?? "dark";
}

/** Put a palette on the document.
 *
 *  The built-in theme is the ABSENCE of any override: clear whatever inline
 *  properties a previous uploaded palette left and stop, so bare :root shows
 *  through. An uploaded palette is written token by token as inline custom
 *  properties, which beat every stylesheet rule no matter the source order and
 *  are removed one by one when the user switches back. */
function apply(id: string) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const prop of appliedProps) root.style.removeProperty(prop);
  appliedProps = [];
  const theme = findTheme(id);
  if (!theme || !theme.custom) return; // built-in: nothing to add
  const palette = (theme as CustomTheme).palette;
  for (const [token, value] of Object.entries(palette)) {
    root.style.setProperty(token, value);
    appliedProps.push(token);
  }
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
 *  CSS needs no subscriber, it re-cascades on its own. This exists for the parts
 *  that CANNOT: the Three.js viewport, whose materials hold resolved numbers
 *  rather than references to a custom property (see viewport/themeColors.ts). */
export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Put the stored theme on the document. Call once at startup.
 *
 *  Needed even though `activeId` is read at module load, because reading it does
 *  not write anything, and a stored uploaded palette would otherwise show the
 *  built-in look until the user changed something. */
export function initTheme() {
  apply(activeId);
}

// --- uploading and removing palettes ----------------------------------------

function slug(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `custom-${base || "theme"}`;
}

/** A collision-proof id from a label. Two files called "Midnight" must not share
 *  an id (setTheme would accept it, the picker would show whichever came first),
 *  so a numeric suffix is added until the id is free. */
function uniqueId(label: string): string {
  const taken = new Set(themes().map((t) => t.id));
  const base = slug(label);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function asMode(v: unknown): "dark" | "light" {
  return v === "light" ? "light" : "dark";
}

/** Pull the colour tokens out of an object, keeping only whitelisted keys whose
 *  values parse as a colour. Accepts both a flat `{ "--bg": "#..." }` map and a
 *  nested `{ palette: { ... } }` wrapper, because both are natural ways to hand
 *  over a palette and rejecting one on a technicality helps nobody. Returns the
 *  cleaned map, which may be empty. */
function extractPalette(source: Record<string, unknown>): Record<string, string> {
  const raw =
    source.palette && typeof source.palette === "object"
      ? (source.palette as Record<string, unknown>)
      : source;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const token = key.toLowerCase();
    if (PALETTE_TOKENS.has(token) && typeof value === "string" && COLOR_RE.test(value.trim())) {
      out[token] = value.trim();
    }
  }
  return out;
}

/** Rebuild a stored library entry, applying the same validation an upload gets.
 *  Anything malformed becomes null and is dropped by the caller. */
function coerceStored(entry: unknown): CustomTheme | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const id = typeof e.id === "string" && e.id ? e.id : null;
  const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : null;
  if (!id || !label || id === BUILTIN_THEME.id) return null;
  const palette = extractPalette(e);
  if (Object.keys(palette).length === 0) return null;
  return { id, label, mode: asMode(e.mode), custom: true, palette };
}

export type UploadResult = { ok: true; theme: CustomTheme } | { ok: false; error: string };

/** Validate an uploaded palette and add it to the library.
 *
 *  `source` is whatever JSON.parse produced from the file; `fallbackLabel` is
 *  the file's name, used when the file itself names no label. Returns a result
 *  rather than throwing so the settings surface can show the reason a file was
 *  refused, which is the whole point of validating at upload time. On success
 *  the theme is stored but NOT switched to, the caller decides that, because
 *  "added it to your library" and "made it active" are two different intents and
 *  a settings surface may want to add several before choosing. */
export function addCustomTheme(source: unknown, fallbackLabel = "Custom theme"): UploadResult {
  if (!source || typeof source !== "object") {
    return { ok: false, error: "That file is not a theme (expected a JSON object of colour tokens)." };
  }
  const src = source as Record<string, unknown>;
  const palette = extractPalette(src);
  if (Object.keys(palette).length === 0) {
    return {
      ok: false,
      error: "No usable colours found. A theme is a JSON object like { \"--bg\": \"#141414\", \"--accent\": \"#f0982d\" }.",
    };
  }
  if (library.length >= MAX_CUSTOM) {
    return { ok: false, error: `The theme library is full (${MAX_CUSTOM}). Remove one before adding another.` };
  }
  const rawLabel =
    (typeof src.label === "string" && src.label.trim()) ||
    (typeof src.name === "string" && src.name.trim()) ||
    fallbackLabel.replace(/\.[^.]+$/, "").trim() ||
    "Custom theme";
  const theme: CustomTheme = {
    id: uniqueId(rawLabel),
    label: rawLabel,
    mode: asMode(src.mode),
    custom: true,
    palette,
  };
  library = [...library, theme];
  writeLibrary(library);
  return { ok: true, theme };
}

/** Remove an uploaded palette. If it was the active theme, fall back to the
 *  built-in one (and repaint), so removing what you are looking at never leaves
 *  the app pointing at a palette that no longer exists. The built-in theme's id
 *  is not removable and is ignored here. */
export function removeCustomTheme(id: string) {
  if (id === BUILTIN_THEME.id) return;
  const before = library.length;
  library = library.filter((t) => t.id !== id);
  if (library.length === before) return;
  writeLibrary(library);
  if (activeId === id) {
    // Straight to the built-in look: clear the pointer through setTheme so the
    // stored id, the DOM and the viewport all move together.
    activeId = DEFAULT_THEME_ID;
    apply(activeId);
    try {
      localStorage.setItem(KEY, activeId);
    } catch {
      /* no storage: the revert holds for the session regardless */
    }
    for (const fn of listeners) fn();
  }
}
