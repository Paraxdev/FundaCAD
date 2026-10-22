// The stylesheet's theme tokens as 0xRRGGBB for Three.js, whose materials hold
// resolved numbers and so never re-cascade on a theme change by themselves.

import { onThemeChange } from "../ui/theme";

/** getComputedStyle forces a style resolution and these are read from tick loops. */
const cache = new Map<string, number>();

onThemeChange(() => cache.clear());

/** Alpha is dropped, Three keeps opacity on the material. Anything unparseable is
 *  null so the caller's literal wins instead of painting a manipulator black. */
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
    const v = p.endsWith("%") ? (Number.parseFloat(p) / 100) * 255 : Number.parseFloat(p);
    return Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : null;
  });
  if (ch.some((c) => c === null)) return null;
  return ((ch[0] as number) << 16) | ((ch[1] as number) << 8) | (ch[2] as number);
}

/** `fallback` serves when there is no document (tests, workers) or the token is
 *  missing, and keeps each colour's default next to the code that means it. */
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

/** For tests and palette changes that bypass ui/theme, like a live stylesheet edit in dev. */
export function invalidateThemeColors() {
  cache.clear();
}
