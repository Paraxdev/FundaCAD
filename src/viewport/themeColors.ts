// Theme colours for the Three.js side.
//
// The chrome re-cascades by itself when the theme changes; the viewport cannot.
// A material holds a resolved number, not a reference to a custom property, so
// without this the manipulators would keep their molten amber under a steel-blue
// theme, the one part of the app visibly belonging to a different palette, and
// the part the user is looking at most.
//
// So: read the SAME custom properties the stylesheet uses, resolved off the
// document root, and hand them back as the 0xRRGGBB numbers Three wants. One
// source of truth, and adding a themed viewport colour means adding a token
// rather than a second palette in TypeScript.

import { onThemeChange } from "../ui/theme";

/** Resolved values, keyed by custom-property name.
 *
 *  getComputedStyle is a forced style resolution, cheap once, absurd per frame,
 *  and these are read from tick loops. The cache is cleared wholesale on a theme
 *  change, which is the only thing that can invalidate it. */
const cache = new Map<string, number>();

onThemeChange(() => cache.clear());

/** Parse the shapes a token can legally hold into 0xRRGGBB.
 *
 *  Handles `#rgb`, `#rrggbb` and `rgb()/rgba()`, because the palette uses all
 *  three, the accent is hex but its tints are rgba, and a tint is exactly the
 *  kind of token someone will reach for next. Alpha is dropped: Three keeps
 *  opacity on the material, not in the colour.
 *
 *  Returns null rather than a guess on anything else, so an unparseable token
 *  falls back to the caller's literal instead of painting a manipulator black. */
export function parseCssColor(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = hex[0]!;
      const g = hex[1]!;
      const b = hex[2]!;
      const n = Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
      return Number.isNaN(n) ? null : n;
    }
    if (hex.length === 6 || hex.length === 8) {
      const n = Number.parseInt(hex.slice(0, 6), 16);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (!m) return null;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const ch = parts.slice(0, 3).map((p) => {
    const v = p.endsWith("%")
      ? (Number.parseFloat(p) / 100) * 255
      : Number.parseFloat(p);
    return Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : null;
  });
  if (ch.some((c) => c === null)) return null;
  return ((ch[0] as number) << 16) | ((ch[1] as number) << 8) | (ch[2] as number);
}

/** The current value of a theme token as 0xRRGGBB, or `fallback` when there is
 *  no document to read (tests, workers) or the token is missing/unparseable.
 *
 *  Callers pass their own literal as the fallback rather than sharing one here:
 *  it keeps each colour's default next to the code that means it, and it is what
 *  lets this be adopted one call site at a time without a flag day. */
export function themeColor(token: string, fallback: number): number {
  const hit = cache.get(token);
  if (hit !== undefined) return hit;
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return fallback;
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token);
  const parsed = parseCssColor(raw);
  const value = parsed ?? fallback;
  cache.set(token, value);
  return value;
}

/** Drop every resolved value. Exposed for tests and for anything that changes
 *  the palette without going through ui/theme (a live stylesheet edit in dev). */
export function invalidateThemeColors() {
  cache.clear();
}
