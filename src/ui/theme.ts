// The active theme: the built-in palette on :root in styles/_tokens.scss, or a
// JSON palette of colour tokens the user uploaded. Only colour tokens are read,
// so a theme is a repaint and never a relayout.
//
// An uploaded palette is written as inline custom properties on the document
// element, which outranks any stylesheet rule regardless of source order. The
// built-in theme is the absence of those, so a failure here still looks right.

import { readSetting } from "./storedSetting";

export interface Theme {
  id: string;
  label: string;
  /** For grouping in the picker only; `color-scheme` does the styling. */
  mode: "dark" | "light";
  /** Uploaded, and so removable. */
  custom: boolean;
}

/** `palette` only holds whitelisted tokens with values that parse as colours. */
export interface CustomTheme extends Theme {
  custom: true;
  palette: Record<string, string>;
}

export const BUILTIN_THEME: Theme = { id: "fundacad", label: "FundaCAD Noir", mode: "dark", custom: false };

export const DEFAULT_THEME_ID = BUILTIN_THEME.id;

const KEY = "fundacad.theme";
const LEGACY_KEYS = ["neocad.theme", "sindricad.theme"];
const LIBRARY_KEY = "fundacad.themes";

/** The palette half of _tokens.scss. Anything else in a file is dropped. */
const PALETTE_TOKENS = new Set<string>([
  "--bg", "--panel", "--panel-2", "--raised", "--raised-2", "--viewport-bg",
  "--line", "--line-strong",
  "--text", "--text-dim", "--text-mute",
  "--accent", "--accent-hot", "--accent-tint", "--accent-tint-2", "--accent-glow", "--on-accent",
  "--ok", "--warn", "--error", "--error-tint",
  "--accent-blue",
]);

/** Hex or rgb()/rgba() only: viewport/themeColors.parseCssColor understands
 *  exactly these, so the 3D view can always draw in a palette's accent. */
const COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$|^rgba?\([0-9.,%\s/]+\)$/i;

/** Keeps a stuck upload loop from filling localStorage, which every setting shares. */
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
  // Stored entries are as untrusted as an upload: other builds and hand edits write here.
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
  }
}

let library: CustomTheme[] = readLibrary();

export function themes(): Theme[] {
  return [BUILTIN_THEME, ...library];
}

export function customThemes(): CustomTheme[] {
  return library.slice();
}

function findTheme(id: string): Theme | undefined {
  return id === BUILTIN_THEME.id ? BUILTIN_THEME : library.find((t) => t.id === id);
}

/** A theme id that exists right now, or null. */
export function asThemeId(v: unknown): string | null {
  return typeof v === "string" && findTheme(v) !== undefined ? v : null;
}

function readStored(): string {
  return asThemeId(readSetting(KEY, ...LEGACY_KEYS)) ?? DEFAULT_THEME_ID;
}

let activeId = readStored();
const listeners = new Set<() => void>();
let appliedProps: string[] = [];

export function getTheme(): string {
  return activeId;
}

export function themeMode(id: string = activeId): "dark" | "light" {
  return findTheme(id)?.mode ?? "dark";
}

function apply(id: string) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const prop of appliedProps) root.style.removeProperty(prop);
  appliedProps = [];
  const theme = findTheme(id);
  if (!theme || !theme.custom) return;
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
    /* no storage: the choice lasts for the session */
  }
  for (const fn of listeners) fn();
}

/** For the Three.js viewport, whose materials hold resolved colours, not custom properties. */
export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Put the stored theme on the document. Call once at startup. */
export function initTheme() {
  apply(activeId);
}

// --- uploading and removing palettes ----------------------------------------

function slug(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `custom-${base || "theme"}`;
}

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

/** Accepts a flat `{ "--bg": "#..." }` map or a `{ palette: { ... } }` wrapper. */
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

/** Validate a parsed palette file and add it to the library without switching to it.
 *  `fallbackLabel` is the file name, used when the file names no label. */
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

/** Remove an uploaded palette, falling back to the built-in one if it was active. */
export function removeCustomTheme(id: string) {
  if (id === BUILTIN_THEME.id) return;
  const before = library.length;
  library = library.filter((t) => t.id !== id);
  if (library.length === before) return;
  writeLibrary(library);
  if (activeId === id) {
    activeId = DEFAULT_THEME_ID;
    apply(activeId);
    try {
      localStorage.setItem(KEY, activeId);
    } catch {
      /* no storage: the revert lasts for the session */
    }
    for (const fn of listeners) fn();
  }
}
