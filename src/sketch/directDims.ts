// Writing a driving length / diameter straight into the geometry, for machines
// with no constraint solver.
//
// A line's length, a circle's diameter and a rectangle's width and height go
// through a solver constraint rather than editing coordinates (see
// SketchMode.editDimension; line angle is a direct write). So where the
// solver's WASM will not start, those were the dimensions that silently did
// NOTHING: the constraint was recorded, never solved, and the shape kept the
// size it was drawn at. That is exactly how it reached us, from a
// Windows user on 0.1.100 whose WebView2 refused to compile WebAssembly:
// "when creating a circle I am unable to put in a new value for the dimension.
// Other shapes seem to work fine."
//
// This is a stand-in, not a solver. The constraints are left in place, so once a
// real solver is available it drives the geometry properly and a sketch authored
// here is indistinguishable from one authored on a working machine.

import type { ResolvedEntity } from "./snap";
import type { DimField, SketchConstraint } from "../types";
import { dimPlaceOf } from "../types";
import { newConstraintId } from "./id";

const EPS = 1e-9;

/** Apply what can be applied without solving. Mutates `entities` in place and
 *  returns true if anything actually moved.
 *
 *  Only single-entity dimensions are handled. Anything relating two entities
 *  (point-to-point, radial gap, angle between lines) needs a solve to decide
 *  WHICH end moves, and guessing would put geometry somewhere the user never
 *  asked for. Those stay unapplied rather than applied wrongly. */
export function applyDrivingDimsDirect(
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
): boolean {
  let changed = false;
  for (const c of constraints) {
    if (c.type === "diameter") {
      const e = entities.find((x) => x.id === c.circle);
      if (e?.type !== "circle" || !(c.value > 0)) continue;
      if (Math.abs(e.radius - c.value / 2) <= EPS) continue;
      e.radius = c.value / 2;
      changed = true;
    } else if (c.type === "p2pDistance" && !c.driven) {
      const field = rectSideField(c);
      const e = field ? entities.find((x) => x.id === c.e1) : undefined;
      if (e?.type !== "rectangle" || !(c.value > 0)) continue;
      const cur = field === "width" ? e.width : e.height;
      if (Math.abs(cur - c.value) <= EPS) continue;
      // Hold corner 0 (where an origin pin sits) and grow away from it.
      const a = ((e.angle ?? 0) * Math.PI) / 180;
      const half = (c.value - cur) / 2;
      const ux = field === "width" ? Math.cos(a) : -Math.sin(a);
      const uy = field === "width" ? Math.sin(a) : Math.cos(a);
      e.x += ux * half;
      e.y += uy * half;
      if (field === "width") e.width = c.value;
      else e.height = c.value;
      changed = true;
    } else if (c.type === "distance") {
      const e = entities.find((x) => x.id === c.line);
      if (e?.type !== "line" || !(c.value > 0)) continue;
      const dx = e.x2 - e.x1;
      const dy = e.y2 - e.y1;
      const len = Math.hypot(dx, dy);
      // a zero-length line has no direction to grow along; leave it alone
      if (len <= EPS || Math.abs(len - c.value) <= EPS) continue;
      // Hold the start and slide the end along the existing direction. With no
      // solver there is nothing to say the other end should move, and this is
      // the least surprising of the two.
      e.x2 = e.x1 + (dx / len) * c.value;
      e.y2 = e.y1 + (dy / len) * c.value;
      changed = true;
    }
  }
  return changed;
}

/** Which side of its own rectangle a same-entity p2pDistance measures, by the
 *  corner pair (rectCorners order): 0-1 and 2-3 are the width, 1-2 and 3-0 the
 *  height. The caller checks that `e1` really is a rectangle. */
export function rectSideField(c: SketchConstraint): "width" | "height" | null {
  if (c.type !== "p2pDistance" || c.e1 !== c.e2) return null;
  const lo = Math.min(c.p1, c.p2), hi = Math.max(c.p1, c.p2);
  if ((lo === 0 && hi === 1) || (lo === 2 && hi === 3)) return "width";
  if ((lo === 1 && hi === 2) || (lo === 0 && hi === 3)) return "height";
  return null;
}

export type DrivingDim = Extract<SketchConstraint, { type: "distance" | "diameter" | "p2pDistance" }>;

/** The driving constraint a typed value on `entity`'s `field` badge becomes, or
 *  null when that field is a direct coordinate write (line angle, slot, polygon,
 *  and a rotated rectangle, which the solver pins rigid so a side dim would only
 *  fight the pins).
 *  A rectangle side is picked by the corner pair whose default label side is the
 *  badge's own (below for the width, left for the height), and a dragged badge
 *  hands its placement over, so the label stays put when it starts driving. */
export function drivingDimFor(entity: ResolvedEntity, field: DimField, mm: number): DrivingDim | null {
  if (entity.type === "line" && field === "length") return { type: "distance", line: entity.id, value: mm };
  if (entity.type === "circle" && field === "diameter") return { type: "diameter", circle: entity.id, value: mm };
  if (entity.type === "rectangle" && !entity.angle && (field === "width" || field === "height")) {
    const [p1, p2] = field === "width" ? [1, 0] : [0, 3];
    const place = dimPlaceOf(entity)?.[field];
    return { type: "p2pDistance", e1: entity.id, p1, e2: entity.id, p2, value: mm, ...(place ? { place: { ...place } } : {}) };
  }
  return null;
}

/** The driving constraint already holding `entity`'s `field`, if any. */
export function findDrivingDim(
  constraints: SketchConstraint[],
  entity: ResolvedEntity,
  field: DimField,
): SketchConstraint | undefined {
  if (entity.type === "line" && field === "length") return constraints.find((k) => k.type === "distance" && k.line === entity.id);
  if (entity.type === "circle" && field === "diameter") return constraints.find((k) => k.type === "diameter" && k.circle === entity.id);
  if (entity.type === "rectangle") {
    return constraints.find((k) => k.type === "p2pDistance" && !k.driven && k.e1 === entity.id && rectSideField(k) === field);
  }
  return undefined;
}

/** `<entityId>:<field>` for every rectangle side a driving constraint holds. Its
 *  constraint label shows the value (editable, deletable, red on a conflict), so
 *  the entity badge for the same side is left out rather than drawn twice. */
export function drivenBadges(entities: ResolvedEntity[], constraints: SketchConstraint[]): Set<string> {
  const rects = new Set(entities.filter((e) => e.type === "rectangle").map((e) => e.id));
  const out = new Set<string>();
  for (const c of constraints) {
    if (c.type !== "p2pDistance" || c.driven || !rects.has(c.e1)) continue;
    const f = rectSideField(c);
    if (f) out.add(`${c.e1}:${f}`);
  }
  return out;
}

/** The other end of the same rule: SketchMode.editDimension routes a typed
 *  line length, circle diameter or rectangle width/height through a driving
 *  constraint so the solver keeps whatever else is pinned to that entity (a
 *  coincident endpoint, a corner on the origin) intact, rather than sliding just
 *  that one coordinate. An editor with no live solve session (FeatureProperties,
 *  editing a feature that is not open) needs the same routing before it hands
 *  entities+constraints to a headless solve, or the field it exposes is the trap
 *  SK-7 was: it looks like every other dimension row but quietly breaks a
 *  closure the moment you type into it.
 *
 *  Returns the constraint list with the driving dim upserted (dedup by target,
 *  same id if one already drove it), or null when `field` is one of the ones
 *  that edit coordinates directly (line angle, slot, polygon), for the caller to
 *  fall back to entityDims' own write(). */
export function upsertDrivingDim(
  constraints: SketchConstraint[],
  entity: ResolvedEntity,
  field: DimField,
  mm: number,
): SketchConstraint[] | null {
  const fresh = drivingDimFor(entity, field, mm);
  if (!fresh) return null;
  const existing = findDrivingDim(constraints, entity, field);
  if (existing && "id" in existing && existing.id) fresh.id = existing.id;
  else fresh.id = newConstraintId();
  if (existing?.type === "p2pDistance" && fresh.type === "p2pDistance") {
    fresh.p1 = existing.p1;
    fresh.p2 = existing.p2;
    if (existing.place) fresh.place = existing.place;
  }
  return [...constraints.filter((k) => k !== existing), fresh];
}
