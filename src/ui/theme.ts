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

/** A palette FundaCAD ships with, selectable like the built-in theme but, like it,
 *  not removable: only an uploaded theme (custom: true) gets a Remove button. */
export interface ShippedTheme extends Theme {
  custom: false;
  palette: Record<string, string>;
}

export const BUILTIN_THEME: Theme = { id: "fundacad", label: "FundaCAD Noir", mode: "dark", custom: false };

export const DEFAULT_THEME_ID = BUILTIN_THEME.id;

/** FundaCAD Noir's surfaces, shared by the Noir <Color> variants below: only
 *  the accent changes, for someone who wants the same dark shell without the
 *  default mint-green (or Dracula's purple). */
const NOIR_SURFACE = {
  "--bg": "#050409",
  "--panel": "#1b1826",
  "--panel-2": "#272233",
  "--raised": "#322c42",
  "--raised-2": "#3d3651",
  "--viewport-bg": "#0b0912",
  "--line": "#322c42",
  "--line-strong": "#5c5470",
  "--text": "#f6f0e4",
  "--text-dim": "#aaa1b5",
  "--text-mute": "#7d7590",
  "--ok": "#17c99a",
  "--warn": "#ffab2e",
  "--error": "#ff5c5c",
  "--error-tint": "rgba(255, 92, 92, 0.14)",
};

function noirTint(
  id: string,
  label: string,
  accent: { accent: string; accentHot: string; onAccent: string },
): ShippedTheme {
  const rgb = accent.accent
    .slice(1)
    .match(/.{2}/g)!
    .map((h) => Number.parseInt(h, 16))
    .join(", ");
  return {
    id,
    label,
    mode: "dark",
    custom: false,
    palette: {
      ...NOIR_SURFACE,
      "--accent": accent.accent,
      "--accent-hot": accent.accentHot,
      "--accent-tint": `rgba(${rgb}, 0.14)`,
      "--accent-tint-2": `rgba(${rgb}, 0.24)`,
      "--accent-glow": `rgba(${rgb}, 0.35)`,
      "--on-accent": accent.onAccent,
      "--accent-blue": accent.accent,
    },
  };
}

/** A couple of well-known palettes, plus dark Noir variants that keep the
 *  built-in theme's shell but swap its mint-green accent for another hue. */
const SHIPPED_THEMES: ShippedTheme[] = [
  {
    id: "dracula",
    label: "Dracula",
    mode: "dark",
    custom: false,
    palette: {
      "--bg": "#282a36",
      "--panel": "#2b2d3a",
      "--panel-2": "#343746",
      "--raised": "#3d4052",
      "--raised-2": "#454858",
      "--viewport-bg": "#1e1f29",
      "--line": "#44475a",
      "--line-strong": "#6272a4",
      "--text": "#f8f8f2",
      "--text-dim": "#c9c7cc",
      "--text-mute": "#9aa0b0",
      "--accent": "#bd93f9",
      "--accent-hot": "#d6acff",
      "--accent-tint": "rgba(189, 147, 249, 0.14)",
      "--accent-tint-2": "rgba(189, 147, 249, 0.24)",
      "--accent-glow": "rgba(189, 147, 249, 0.35)",
      "--on-accent": "#1b0f2e",
      "--ok": "#50fa7b",
      "--warn": "#ffb86c",
      "--error": "#ff5555",
      "--error-tint": "rgba(255, 85, 85, 0.14)",
      "--accent-blue": "#8be9fd",
    },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    mode: "light",
    custom: false,
    palette: {
      "--bg": "#fdf6e3",
      "--panel": "#eee8d5",
      "--panel-2": "#e3ddc7",
      "--raised": "#ffffff",
      "--raised-2": "#f5efdc",
      "--viewport-bg": "#eee8d5",
      "--line": "#d6cfb4",
      "--line-strong": "#93a1a1",
      "--text": "#073642",
      "--text-dim": "#586e75",
      "--text-mute": "#839496",
      "--accent": "#268bd2",
      "--accent-hot": "#4aa3e0",
      "--accent-tint": "rgba(38, 139, 210, 0.14)",
      "--accent-tint-2": "rgba(38, 139, 210, 0.24)",
      "--accent-glow": "rgba(38, 139, 210, 0.35)",
      "--on-accent": "#fdf6e3",
      "--ok": "#859900",
      "--warn": "#b58900",
      "--error": "#dc322f",
      "--error-tint": "rgba(220, 50, 47, 0.14)",
      "--accent-blue": "#268bd2",
    },
  },
  {
    // A theme that stays legible for every kind of colour blindness. Its four
    // signal colours were chosen and simulation-checked so no two collapse under
    // protanopia, deuteranopia or tritanopia (the closest pair holds a CIE ΔE of
    // ~29), and their lightness also steps apart so the ok/warn/error trio still
    // separates under monochromacy, where hue carries nothing. The accent is
    // violet rather than a second blue: a blue accent merged with the teal ok
    // under tritanopia. ok leans teal, not pure green, to keep a blue axis under
    // red-green blindness; warn is amber, error a bright red that still clears
    // ~6:1 contrast on the dark surface, since --error is drawn as text.
    // Surfaces are near-neutral so those signals are what the eye lands on.
    id: "colorblind-safe",
    label: "Colour-Blind Safe",
    mode: "dark",
    custom: false,
    palette: {
      "--bg": "#0e1116",
      "--panel": "#161b22",
      "--panel-2": "#1c232c",
      "--raised": "#232c37",
      "--raised-2": "#2b3542",
      "--viewport-bg": "#0b0e13",
      "--line": "#2b3542",
      "--line-strong": "#58697a",
      "--text": "#f5f7fa",
      "--text-dim": "#b5c0cc",
      "--text-mute": "#7e8b99",
      "--accent": "#8f7fe8",
      "--accent-hot": "#ab9cf2",
      "--accent-tint": "rgba(143, 127, 232, 0.14)",
      "--accent-tint-2": "rgba(143, 127, 232, 0.24)",
      "--accent-glow": "rgba(143, 127, 232, 0.35)",
      "--on-accent": "#0d0a1f",
      "--ok": "#2ec4b6",
      "--warn": "#f4c542",
      "--error": "#ff5c5c",
      "--error-tint": "rgba(255, 92, 92, 0.16)",
      "--accent-blue": "#8f7fe8",
    },
  },
  noirTint("noir-blue", "Noir Blue", {
    accent: "#3fa9f5",
    accentHot: "#7ecbff",
    onAccent: "#001522",
  }),
  noirTint("noir-red", "Noir Red", {
    accent: "#ff4d6d",
    accentHot: "#ff8098",
    onAccent: "#2a0008",
  }),
  noirTint("noir-orange", "Noir Orange", {
    accent: "#ff8a3d",
    accentHot: "#ffb374",
    onAccent: "#2b1200",
  }),
];

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
  const seen = new Set<string>([BUILTIN_THEME.id, ...SHIPPED_THEMES.map((t) => t.id)]);
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
  return [BUILTIN_THEME, ...SHIPPED_THEMES, ...library];
}

export function customThemes(): CustomTheme[] {
  return library.slice();
}

function findTheme(id: string): Theme | undefined {
  if (id === BUILTIN_THEME.id) return BUILTIN_THEME;
  return SHIPPED_THEMES.find((t) => t.id === id) ?? library.find((t) => t.id === id);
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
  root.style.removeProperty("color-scheme");
  const theme = findTheme(id);
  // The built-in theme lives on :root in _tokens.scss, nothing to apply here.
  if (!theme || !("palette" in theme)) return;
  const palette = (theme as CustomTheme | ShippedTheme).palette;
  for (const [token, value] of Object.entries(palette)) {
    root.style.setProperty(token, value);
    appliedProps.push(token);
  }
  // Native controls (selects, scrollbars) need to know a light palette is no longer dark.
  root.style.setProperty("color-scheme", theme.mode);
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
