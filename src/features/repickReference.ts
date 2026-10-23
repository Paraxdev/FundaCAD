// Ambiguous reference repair. The engine reports the failing selector by its stored point (ResolveDiag `at`), not
// an index, since its own grouping (_group_sels_by_body) does not keep selector order.

import type { Feature, Selector, TrackedFaceRecord, Vec3 } from "../types";
import { edgeMatchSelectorFrom } from "../viewport/edgeMatch";
import { trackedFace, withExtent } from "./holeFace";

// Every feature field that can carry selectors, each `Selector | Selector[]`: fillet/chamfer `edges`, press-pull and
// deleteFace `face` (+ `upTo`), shell/offsetFace/thicken/draft `faces`, datumAxis `axisEdge`.
const SELECTOR_FIELDS = ["edges", "face", "faces", "upTo", "axisEdge"] as const;
type SelectorField = (typeof SELECTOR_FIELDS)[number];
// Datum references nest their selectors inside these, at any depth.
const NESTED_FIELDS = ["through", "at"] as const;

/** Where a selector lives inside a feature. `index` is null for a scalar field;
 *  `path` leads from a nested field's value down to the selector. */
export interface SelectorSite {
  field: SelectorField | (typeof NESTED_FIELDS)[number];
  index: number | null;
  path?: (string | number)[];
}

// The engine rounds `at` to 6 decimals while the document keeps full precision.
const MATCH_TOL = 1e-4;

function isNearestAt(sel: unknown, at: readonly number[]): boolean {
  if (!sel || typeof sel !== "object") return false;
  const s = sel as { by?: string; point?: unknown; fp?: { mid?: unknown } };
  const p = s.by === "nearest" || s.by === "tracked" ? s.point : s.by === "match" ? s.fp?.mid : undefined;
  if (!Array.isArray(p) || p.length !== 3) return false;
  return p.every((v, i) => typeof v === "number" && Math.abs(v - (at[i] ?? NaN)) <= MATCH_TOL);
}

function isSelector(v: unknown): boolean {
  return !!v && typeof v === "object" && "kind" in v && "by" in v;
}

function nestedPathTo(val: unknown, at: readonly number[]): (string | number)[] | null {
  if (!val || typeof val !== "object") return null;
  if (isSelector(val)) return isNearestAt(val, at) ? [] : null;
  const entries: [string | number, unknown][] = Array.isArray(val) ? val.map((v, i) => [i, v]) : Object.entries(val);
  for (const [k, v] of entries) {
    const rest = nestedPathTo(v, at);
    if (rest) return [k, ...rest];
  }
  return null;
}

/** Null is legitimate: the user may have re-picked or edited since the failing rebuild. Treat it as nothing to repair. */
export function findSelectorAt(feature: Feature, at: readonly number[]): SelectorSite | null {
  for (const field of SELECTOR_FIELDS) {
    const val = (feature as unknown as Record<string, unknown>)[field];
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      const index = val.findIndex((s) => isNearestAt(s, at));
      if (index >= 0) return { field, index };
    } else if (isNearestAt(val, at)) {
      return { field, index: null };
    }
  }
  for (const field of NESTED_FIELDS) {
    const path = nestedPathTo((feature as unknown as Record<string, unknown>)[field], at);
    if (path && path.length > 0) return { field, index: null, path };
  }
  return null;
}

/** Preserves the field's shape: a scalar stays scalar and an array keeps its length. */
export function replaceSelectorAt(feature: Feature, site: SelectorSite, next: Selector): Partial<Feature> {
  if (site.path) {
    const root = structuredClone((feature as unknown as Record<string, unknown>)[site.field]) as Record<
      string | number,
      unknown
    >;
    let node = root;
    for (const k of site.path.slice(0, -1)) node = node[k] as Record<string | number, unknown>;
    node[site.path[site.path.length - 1]!] = next;
    return { [site.field]: root } as Partial<Feature>;
  }
  if (site.index === null) return { [site.field]: next } as Partial<Feature>;
  const cur = (feature as unknown as Record<string, unknown>)[site.field];
  const arr = Array.isArray(cur) ? [...(cur as Selector[])] : [];
  arr[site.index] = next;
  return { [site.field]: arr } as Partial<Feature>;
}

/** Written as the Hole or datum tool writes it, a tracked face or an edge by fingerprint, so it keeps following
 *  after the re-pick. */
export function repickedSelector(
  feature: Feature,
  site: SelectorSite,
  picked: Selector,
  normal: Vec3 | null,
  edgePoints?: readonly Vec3[],
): Selector {
  if (site.path) {
    if (picked.kind === "face" && picked.by === "nearest" && normal)
      return trackedFace(picked.point, normal, picked.body ?? null);
    if (picked.kind === "edge" && edgePoints) {
      return (
        (edgeMatchSelectorFrom({ points: [...edgePoints], body: picked.body ?? undefined }) as Selector | undefined) ??
        picked
      );
    }
    return picked;
  }
  if (feature.type !== "hole" || site.field !== "face" || site.index !== null || !normal) return picked;
  if (picked.kind !== "face" || picked.by !== "nearest") return picked;
  return trackedFace(picked.point, normal, picked.body ?? null);
}

/** Null until the build is of the re-picked face, at the pick point it was written with. */
export function repickedExtent(
  feature: Feature | undefined,
  written: Selector,
  rec: TrackedFaceRecord | undefined,
): Partial<Feature> | null {
  if (!feature || feature.type !== "hole" || written.by !== "tracked" || !rec) return null;
  const face = (feature as { face?: Selector }).face;
  if (!face || JSON.stringify(face) !== JSON.stringify(written)) return null;
  if (rec.point.some((v, i) => Math.abs(v - written.point[i]!) > MATCH_TOL)) return null;
  const next = withExtent(face, rec);
  return next === face ? null : ({ face: next } as Partial<Feature>);
}

// Codes a face pick can clear (geom_select CODE_*). Not `planeTilted`: resolve_face_on_plane filters by the cached
// plane's normal and a repair rewrites only the selector, so re-picking reproduces the same diagnostic.
const REPAIRABLE_CODES = new Set(["ambiguousReference", "referenceNotFound"]);

/** Includes a sketch or datum plane that fell back to its cached plane, fixed by the same pick. The prose fallback
 *  stays for engines older than the `code` field, like server.py run from another checkout. */
export function repairableDiagFor(
  diagnostics:
    | {
        feature_id?: string;
        reason?: string;
        code?: string;
        at?: [number, number, number];
        kind?: string;
        candidates?: string[];
      }[]
    | undefined,
  featureId: string,
) {
  return (diagnostics ?? []).find(
    (d) =>
      d.feature_id === featureId &&
      ((d.code !== undefined && REPAIRABLE_CODES.has(d.code)) || d.reason === "ambiguous nearest pick") &&
      Array.isArray(d.at),
  );
}
