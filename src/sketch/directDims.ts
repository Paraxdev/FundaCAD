// Writes a driving length or diameter straight into the geometry where the solver's WASM will not start
// (a WebView2 that refused WebAssembly). The constraints stay, so a real solver later drives them properly.

import type { ResolvedEntity } from "./snap";
import type { DimField, SketchConstraint } from "../types";
import { dimPlaceOf, projEndSamples } from "../types";
import { newConstraintId } from "./id";
import { rectCorners } from "./region";
import { circumcenter } from "./arc";

const EPS = 1e-9;

/** Mutates `entities` and returns true if anything moved. Only single-entity dims: two-entity ones need a solve
 *  to decide which end moves, so they stay unapplied rather than applied wrongly (see waitsForSolver). */
export function applyDrivingDimsDirect(entities: ResolvedEntity[], constraints: SketchConstraint[]): boolean {
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
      const k = heldCorner(e, c, entities, constraints);
      const held = rectCorners(e.x, e.y, e.width, e.height, e.angle)[k]!;
      const w = field === "width" ? c.value : e.width;
      const h = field === "height" ? c.value : e.height;
      const lx = (k === 1 || k === 2 ? 0.5 : -0.5) * w;
      const ly = (k === 2 || k === 3 ? 0.5 : -0.5) * h;
      const a = ((e.angle ?? 0) * Math.PI) / 180;
      e.x = held.x - (lx * Math.cos(a) - ly * Math.sin(a));
      e.y = held.y - (lx * Math.sin(a) + ly * Math.cos(a));
      if (field === "width") e.width = c.value;
      else e.height = c.value;
      changed = true;
    } else if ((c.type === "hDistance" || c.type === "vDistance") && !c.driven) {
      if (c.e1 !== c.e2 || c.p1 === c.p2 || !(c.value > 0)) continue;
      const e = entities.find((x) => x.id === c.e1);
      if (e?.type !== "line" || c.p1 > 1 || c.p2 > 1) continue;
      const k = c.type === "hDistance" ? "x" : "y";
      const at = (p: number) => (p === 0 ? (k === "x" ? e.x1 : e.y1) : k === "x" ? e.x2 : e.y2);
      const set = (p: number, val: number) => {
        if (p === 0) {
          if (k === "x") e.x1 = val;
          else e.y1 = val;
        } else if (k === "x") e.x2 = val;
        else e.y2 = val;
      };
      if (Math.abs(at(c.p2) - at(c.p1) - c.value) <= EPS) continue;
      // the end a solve would hold stays, the other moves along the axis only
      if (lineHeldEnd(e, entities, constraints) === c.p1) set(c.p2, at(c.p1) + c.value);
      else set(c.p1, at(c.p2) - c.value);
      changed = true;
    } else if (c.type === "distance") {
      const e = entities.find((x) => x.id === c.line);
      if (e?.type !== "line" || !(c.value > 0)) continue;
      const dx = e.x2 - e.x1;
      const dy = e.y2 - e.y1;
      const len = Math.hypot(dx, dy);
      // a zero-length line has no direction to grow along; leave it alone
      if (len <= EPS || Math.abs(len - c.value) <= EPS) continue;
      // The same end a solve would hold, the other slides along the line.
      if (lineHeldEnd(e, entities, constraints) === 0) {
        e.x2 = e.x1 + (dx / len) * c.value;
        e.y2 = e.y1 + (dy / len) * c.value;
      } else {
        e.x1 = e.x2 - (dx / len) * c.value;
        e.y1 = e.y2 - (dy / len) * c.value;
      }
      changed = true;
    }
  }
  return changed;
}

/** Driving horizontal or vertical distances the no-solver path leaves alone (all but those along one line),
 *  so the user is told they wait for the solver. */
export function waitsForSolver(entities: ResolvedEntity[], constraints: SketchConstraint[]): number {
  const lines = new Set(entities.filter((e) => e.type === "line").map((e) => e.id));
  return constraints.filter(
    (c) => (c.type === "hDistance" || c.type === "vDistance") && !c.driven && (c.e1 !== c.e2 || !lines.has(c.e1)),
  ).length;
}

/** A pinned corner (a fix on it, a fixed or coincident point, or the origin), else the constraint pair's second. */
function heldCorner(
  e: Extract<ResolvedEntity, { type: "rectangle" }>,
  c: Extract<SketchConstraint, { type: "p2pDistance" }>,
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
): number {
  const fixedPts = new Set<string>();
  const fixedAt: { x: number; y: number }[] = [{ x: 0, y: 0 }];
  for (const k of constraints) {
    if (k.type !== "fix") continue;
    fixedPts.add(k.e);
    const pt = entities.find((x) => x.id === k.e);
    if (pt?.type === "point") fixedAt.push(pt);
  }
  const corners = rectCorners(e.x, e.y, e.width, e.height, e.angle);
  const pinned = (i: number): boolean => {
    const q = corners[i]!;
    if (fixedAt.some((f) => Math.hypot(f.x - q.x, f.y - q.y) <= 1e-6)) return true;
    return constraints.some(
      (k) =>
        (k.type === "fix" && k.e === e.id && k.p === i) ||
        (k.type === "coincident" &&
          ((k.e1 === e.id && k.p1 === i && fixedPts.has(k.e2)) || (k.e2 === e.id && k.p2 === i && fixedPts.has(k.e1)))),
    );
  };
  const found = [0, 1, 2, 3].find(pinned);
  return found ?? c.p2;
}

/** By the corner pair (rectCorners order): 0-1 and 2-3 are the width, 1-2 and 3-0 the height.
 *  The caller checks that `e1` really is a rectangle. */
export function rectSideField(c: SketchConstraint): "width" | "height" | null {
  if (c.type !== "p2pDistance" || c.e1 !== c.e2) return null;
  const lo = Math.min(c.p1, c.p2),
    hi = Math.max(c.p1, c.p2);
  if ((lo === 0 && hi === 1) || (lo === 2 && hi === 3)) return "width";
  if ((lo === 1 && hi === 2) || (lo === 0 && hi === 3)) return "height";
  return null;
}

export type DrivingDim = Extract<SketchConstraint, { type: "distance" | "diameter" | "p2pDistance" }>;

/** Null when the field is a direct coordinate write (line angle, slot, polygon, a rotated rectangle the solver pins
 *  rigid). A rectangle side uses the corner pair whose default label side is the badge's, and a dragged badge hands
 *  its placement over so the label stays put. */
export function drivingDimFor(entity: ResolvedEntity, field: DimField, mm: number): DrivingDim | null {
  if (entity.type === "line" && field === "length") return { type: "distance", line: entity.id, value: mm };
  if (entity.type === "circle" && field === "diameter") return { type: "diameter", circle: entity.id, value: mm };
  if (entity.type === "rectangle" && !entity.angle && (field === "width" || field === "height")) {
    const [p1, p2] = field === "width" ? [1, 0] : [0, 3];
    const place = dimPlaceOf(entity)?.[field];
    return {
      type: "p2pDistance",
      e1: entity.id,
      p1,
      e2: entity.id,
      p2,
      value: mm,
      ...(place ? { place: { ...place } } : {}),
    };
  }
  return null;
}

/** The held end of a line (see solveKeepingAxes), so a length change is taken up at the other end. */
export function dimAnchor(
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
  c: SketchConstraint,
): { x: number; y: number } | undefined {
  if (c.type !== "distance") return undefined;
  const e = entities.find((k) => k.id === c.line);
  if (e?.type !== "line") return undefined;
  return lineHeldEnd(e, entities, constraints) === 0 ? { x: e.x1, y: e.y1 } : { x: e.x2, y: e.y2 };
}

/** The end on fixed geometry when exactly one is, else the smaller x, then smaller y, so a shape grows right and up
 *  whichever way its lines were drawn. */
export function lineHeldEnd(
  e: Extract<ResolvedEntity, { type: "line" }>,
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
): 0 | 1 {
  const a = { x: e.x1, y: e.y1 },
    b = { x: e.x2, y: e.y2 };
  const fixed = fixedPositions(entities, constraints);
  const onFixed = (q: { x: number; y: number }, end: number) =>
    fixed.some((f) => Math.hypot(f.x - q.x, f.y - q.y) <= 1e-6) ||
    constraints.some(
      (k) =>
        k.type === "coincident" &&
        ((k.e1 === e.id && k.p1 === end && isFixedOperand(k.e2, k.p2, entities, constraints)) ||
          (k.e2 === e.id && k.p2 === end && isFixedOperand(k.e1, k.p1, entities, constraints))),
    );
  const fa = onFixed(a, 0),
    fb = onFixed(b, 1);
  if (fa !== fb) return fa ? 0 : 1;
  if (Math.abs(a.x - b.x) > EPS) return a.x < b.x ? 0 : 1;
  return a.y <= b.y ? 0 : 1;
}

/** The origin, every fixed point, projected reference geometry, and the corners of a rotated (rigid) rectangle. */
function fixedPositions(entities: ResolvedEntity[], constraints: SketchConstraint[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [{ x: 0, y: 0 }];
  for (const k of constraints) {
    if (k.type !== "fix") continue;
    const q = entityPoint(
      entities.find((x) => x.id === k.e),
      k.p,
    );
    if (q) out.push(q);
  }
  for (const e of entities) {
    if (e.type === "rectangle" && e.angle) out.push(...rectCorners(e.x, e.y, e.width, e.height, e.angle));
    if (e.type !== "projected") continue;
    const cv = e.curve;
    if (cv.kind === "line" || cv.kind === "arc") out.push({ x: cv.x1, y: cv.y1 }, { x: cv.x2, y: cv.y2 });
    else if (cv.kind === "circle") out.push({ x: cv.x, y: cv.y });
    else out.push(...projEndSamples(cv).map(([x, y]) => ({ x, y })));
  }
  return out;
}

function isFixedOperand(id: string, p: number, entities: ResolvedEntity[], constraints: SketchConstraint[]): boolean {
  const e = entities.find((x) => x.id === id);
  return (
    e?.type === "projected" ||
    constraints.some(
      (k) => k.type === "fix" && k.e === id && (e?.type === "point" || e?.type === "circle" || k.p === p),
    )
  );
}

/** By the `fix` constraint's index semantics (see types.ts). */
function entityPoint(e: ResolvedEntity | undefined, p: number): { x: number; y: number } | null {
  if (!e) return null;
  switch (e.type) {
    case "point":
    case "circle":
    case "polygon":
    case "text":
      return { x: e.x, y: e.y };
    case "rectangle":
      return rectCorners(e.x, e.y, e.width, e.height, e.angle)[p] ?? null;
    case "line":
    case "slot":
      return p === 0 ? { x: e.x1, y: e.y1 } : { x: e.x2, y: e.y2 };
    case "arc":
      if (p !== 2) return p === 0 ? { x: e.x1, y: e.y1 } : { x: e.x2, y: e.y2 };
      return circumcenter({ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }, { x: e.mx, y: e.my });
    default:
      return null;
  }
}

export function findDrivingDim(
  constraints: SketchConstraint[],
  entity: ResolvedEntity,
  field: DimField,
): SketchConstraint | undefined {
  if (entity.type === "line" && field === "length")
    return constraints.find((k) => k.type === "distance" && k.line === entity.id);
  if (entity.type === "circle" && field === "diameter")
    return constraints.find((k) => k.type === "diameter" && k.circle === entity.id);
  if (entity.type === "rectangle") {
    return constraints.find(
      (k) => k.type === "p2pDistance" && !k.driven && k.e1 === entity.id && rectSideField(k) === field,
    );
  }
  return undefined;
}

/** Sides whose constraint label already shows the value (editable, red on conflict), so no badge draws them twice. */
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

/** For editors with no live solve session (FeatureProperties): routes length, diameter and rect sides through a
 *  driving constraint before a headless solve, or the field breaks a closure when typed into (SK-7). Null for fields
 *  that edit coordinates directly, where the caller falls back to entityDims' write(). */
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
