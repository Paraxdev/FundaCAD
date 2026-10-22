import type { SectionGhost, SectionView, Vec3 } from "../types";

/** In the order of GHOST_LEVELS (features/sectionMath.ts), so a dial level is its index here. */
export const SECTION_GHOSTS: readonly SectionGhost[] = ["hidden", "faint", "soft", "strong"];

const KNOWN = new Set(["origin", "normal", "offset", "side", "ghost"]);

function vec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  if (!v.every((c) => typeof c === "number" && Number.isFinite(c))) return null;
  return [v[0], v[1], v[2]];
}

/** The saved cut, or null when `raw` is not one. Loose numbers fall back to a default, a bad structure is refused,
 *  and unknown fields are kept. */
export function readSectionView(raw: unknown): SectionView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const origin = vec3(r.origin);
  const n = vec3(r.normal);
  if (!origin || !n) return null;
  const len = Math.hypot(n[0], n[1], n[2]);
  if (!(len > 1e-12)) return null;
  // Left as it is when already unit length, so reading a cut back twice gives the same numbers.
  const normal: Vec3 = Math.abs(len - 1) < 1e-12 ? n : [n[0] / len, n[1] / len, n[2] / len];
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (!KNOWN.has(k)) extra[k] = structuredClone(v);
  return {
    ...extra,
    origin,
    normal,
    offset: typeof r.offset === "number" && Number.isFinite(r.offset) ? r.offset : 0,
    side: r.side === -1 ? -1 : 1,
    ghost: SECTION_GHOSTS.includes(r.ghost as SectionGhost) ? (r.ghost as SectionGhost) : "soft",
  };
}

/** Same cut on screen: unknown fields are not compared. */
export function sameSectionView(a: SectionView | null, b: SectionView | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.origin.every((c, i) => c === b.origin[i]) &&
    a.normal.every((c, i) => c === b.normal[i]) &&
    a.offset === b.offset &&
    a.side === b.side &&
    a.ghost === b.ghost
  );
}

/** The fields of `v` this version does not read. */
export function sectionViewExtras(v: SectionView | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v) for (const [k, x] of Object.entries(v)) if (!KNOWN.has(k)) out[k] = structuredClone(x);
  return out;
}
