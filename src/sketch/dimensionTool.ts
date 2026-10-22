// The Dimension tool's DOM-free pick layer and pair matrix. The dimension TYPE is decided by the pair, not the first
// pick, and every degenerate pick returns a NAMED error with its toast text. A rect edge is a line operand.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { PlaceOffset, SketchConstraint } from "../types";
import type { DimFieldDef } from "./dimInput";
import {
  asLineSeg,
  asRound,
  dimRefPoints,
  lineRimPoints,
  pointRimPoints,
  radialGapPoints,
  rimGap,
  rimGapPoints,
  type Round,
} from "./entityDims";
import { pickEntity, PROJECTED_FIXED_MSG } from "./modify";
import { rectCorners } from "./region";
import { distToSeg, signedAngleDeg } from "./geom2d";
import { wedgeAt } from "./angleWedge";

type V = THREE.Vector2;
const v = (x: number, y: number) => new THREE.Vector2(x, y);

export type Seg = { x1: number; y1: number; x2: number; y2: number };

/** `entity` is a whole-curve pick, `point` a reference point (dimRefPoints), `edge` one side of a rectangle.
 *  `rim` is Fusion's Pick Circle/Arc Tangent: it arms ONE pick so a round gives its edge, not its centre. */
export type DimTarget =
  | { kind: "point"; e: ResolvedEntity; p: number; pos: V; rim?: true }
  | { kind: "entity"; e: ResolvedEntity; rim?: true }
  | { kind: "edge"; e: ResolvedEntity; k: number; a: V; b: V };

/** The right-click overrides on the in-progress dimension, for what the picks alone do not decide. */
export interface DimOptions {
  /** force a lone round to radius or diameter (default circle diameter, arc radius, like Fusion) */
  roundPref?: "radius" | "diameter";
  /** an angle measures the outside of the wedge the cursor is in */
  reflex?: boolean;
}

export type DimErrorCode =
  | "same-entity"
  | "concentric"
  | "coincident-points"
  | "point-on-line"
  | "degenerate"
  | "overlapping"
  | "crossing"
  | "unsupported"
  | "need-second"
  | "projected-single";

/** `message` is the toast text ("" = deliberately silent); `keepPicks` marks the not finished yet cases where
 *  the pick stays armed as a pair operand. */
export interface DimError {
  error: DimErrorCode;
  message: string;
  keepPicks?: boolean;
}

export interface DimPlan {
  kind: "length" | "distance" | "diameter" | "radius" | "angle";
  field: string;
  fields: DimFieldDef[];
  /** SketchMode re-show()s the box only when this changes, since show() destroys what the user typed */
  fieldKey: string;
  /** mm, or degrees for an angle. `cursor` is the offset from labelAnchor and picks the mode of a dim that has
   *  several (aligned, horizontal or vertical; the angle's wedge). */
  measure(cursor?: PlaceOffset): number;
  anchors(): { a: V; b: V } | null;
  /** what `place` is measured FROM; null when this dim cannot hold a placement */
  labelAnchor(): V | null;
  /** `place` (the frozen label) picks the mode when given, else `cursor` does */
  make(value: number, place?: PlaceOffset, cursor?: PlaceOffset): SketchConstraint;
  /** Lines whose distance only means something while held parallel: one p2lDistance pins one endpoint, so the solver
   *  could rotate the pair instead. SketchMode adds `parallel` unless one already holds them. */
  parallelPair?: { l1: string; l2: string };
  /** Rounds whose radial gap only means something while concentric: `difference` ties the radii and nothing else
   *  (see types.ts). SketchMode adds `concentric` unless one already holds them. */
  implyConcentric?: { c1: string; c2: string };
  /** every operand is fixed reference geometry, so the dim is driven */
  forceDriven?: boolean;
  hint: string;
}

export type DimResolution = DimPlan | DimError;

export const isDimError = (r: DimResolution): r is DimError => (r as DimError).error !== undefined;

/** Closer to parallel than sin(0.1 deg) gives a DISTANCE, not an angle; looser than Fusion so parallel lines robustly
 *  give a distance, while a deliberate 0.2 deg angle still resolves as one. There is no override in v1. */
export const PARALLEL_EPS = Math.sin((0.1 * Math.PI) / 180);

/** below this a measured distance/length/radius is "zero", nothing to drive */
export const MEASURE_EPS = 1e-6;

/** Screen bounds on a frozen label: the floor keeps it out of the geometry, the ceiling on screen at extreme zoom. */
export const MIN_PLACE_PX = 18;
export const MAX_PLACE_PX = 600;

const PROJECTED_PAIR_MSG = `${PROJECTED_FIXED_MSG}, pick a second entity to dimension to it`;
const CONCENTRIC_MSG =
  "These circles are concentric, centre distance is 0. Dimension each diameter, or " +
  "right-click → Pick Circle/Arc Tangent before each pick for the radial gap (wall thickness).";

const segLen = (s: Seg) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);

function dirOf(s: Seg): { x: number; y: number } | null {
  const len = segLen(s);
  if (len < MEASURE_EPS) return null;
  return { x: (s.x2 - s.x1) / len, y: (s.y2 - s.y1) / len };
}

/** distance to the INFINITE line through `s` */
function perpDist(p: { x: number; y: number }, s: Seg): number {
  const len = segLen(s) || 1;
  return Math.abs((p.x - s.x1) * (s.y2 - s.y1) - (p.y - s.y1) * (s.x2 - s.x1)) / len;
}

/** foot of the perpendicular onto the INFINITE line through `s` */
function footOf(p: { x: number; y: number }, s: Seg): V {
  const dx = s.x2 - s.x1,
    dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / len2;
  return v(s.x1 + t * dx, s.y1 + t * dy);
}

const mid = (a: V, b: V) => a.clone().add(b).multiplyScalar(0.5);

/** circles expose their centre at dimRefPoints index 0, arcs at 2, native and projected alike */
function centreIndex(e: ResolvedEntity): number | null {
  if (e.type === "circle") return 0;
  if (e.type === "arc") return 2;
  if (e.type === "projected") {
    if (e.curve.kind === "circle") return 0;
    if (e.curve.kind === "arc") return 2;
  }
  return null;
}

/** rejects picking the same thing twice */
export function targetKey(t: DimTarget): string {
  if (t.kind === "point") return `point:${t.e.id}:${t.p}`;
  if (t.kind === "edge") return `edge:${t.e.id}~${t.k}`;
  return `entity:${t.e.id}`;
}

/** targetKey plus the rim or tangent mode: the mode must not make a re-pick look like a new operand (targetKey
 *  drives "already picked, so this click places"), but it does change which dimension the value box belongs to. */
export function targetIdentity(t: DimTarget): string {
  return t.kind !== "edge" && t.rim ? `${targetKey(t)}~rim` : targetKey(t);
}

export function isRoundTarget(t: DimTarget): boolean {
  return t.kind !== "edge" && asRound(t.e) !== null && centreIndex(t.e) !== null;
}

/** Points beat curve bodies, except a round's rim beats its own centre when both are in tolerance, or a small circle
 *  would lose its diameter. No "click inside a circle means its centre" fallback: it picked the BIG circle of two. */
export function pickDimTarget(ents: ResolvedEntity[], p: V, tol: number): DimTarget | null {
  let best: { e: ResolvedEntity; p: number; pos: V } | null = null;
  let bestD = tol * tol;
  for (const e of ents) {
    for (const r of dimRefPoints(e)) {
      const dx = r.pos.x - p.x,
        dy = r.pos.y - p.y,
        d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = { e, p: r.p, pos: r.pos };
      }
    }
  }
  if (best) {
    const round = asRound(best.e);
    if (round && centreIndex(best.e) === best.p) {
      const dRim = Math.abs(Math.hypot(p.x - round.x, p.y - round.y) - round.r);
      if (dRim <= tol) return { kind: "entity", e: best.e };
    }
    return { kind: "point", e: best.e, p: best.p, pos: best.pos.clone() };
  }
  const idx = pickEntity(ents, p, tol);
  const e = idx >= 0 ? ents[idx] : undefined;
  if (!e) return null;
  if (e.type === "rectangle") {
    const c = rectCorners(e.x, e.y, e.width, e.height, e.angle);
    let bk = 0,
      bd = Infinity;
    for (let k = 0; k < 4; k++) {
      const a = c[k],
        b = c[(k + 1) % 4];
      if (!a || !b) continue;
      const d = distToSeg(a, b, p);
      if (d < bd) {
        bd = d;
        bk = k;
      }
    }
    const a = c[bk],
      b = c[(bk + 1) % 4];
    if (!a || !b) return null;
    return { kind: "edge", e, k: bk, a: a.clone(), b: b.clone() };
  }
  return { kind: "entity", e };
}

/** The solver hands back NEW entity objects, so a held pick goes stale. Null means the geometry is gone. */
export function rebindTarget(t: DimTarget, ents: ResolvedEntity[]): DimTarget | null {
  const e = ents.find((x) => x.id === t.e.id);
  if (!e) return null;
  const rim = t.kind !== "edge" && t.rim ? { rim: true as const } : {};
  if (t.kind === "entity") return { kind: "entity", e, ...rim };
  if (t.kind === "point") {
    const r = dimRefPoints(e).find((q) => q.p === t.p);
    return r ? { kind: "point", e, p: t.p, pos: r.pos.clone(), ...rim } : null;
  }
  if (e.type !== "rectangle") return null;
  const c = rectCorners(e.x, e.y, e.width, e.height, e.angle);
  const a = c[t.k],
    b = c[(t.k + 1) % 4];
  return a && b ? { kind: "edge", e, k: t.k, a: a.clone(), b: b.clone() } : null;
}

/** `mmPerPx <= 0` (no zoom context, tests) leaves it untouched. Null means no frozen placement: the offset is in mm
 *  but the floor is in px, so forcing a tiny click up to it could throw the label off screen at other zooms. */
export function clampPlace(dx: number, dy: number, mmPerPx: number): PlaceOffset | null {
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  if (!(mmPerPx > 0)) return { ox: r4(dx), oy: r4(dy) };
  const lo = MIN_PLACE_PX * mmPerPx,
    hi = MAX_PLACE_PX * mmPerPx;
  const len = Math.hypot(dx, dy);
  if (len < lo) return null; // too close to the geometry to be a deliberate placement
  const s = Math.min(len, hi) / len;
  return { ox: r4(dx * s), oy: r4(dy * s) };
}

interface PointOp {
  kind: "point";
  eid: string;
  p: number;
  pos: V;
  round: boolean;
  fixed: boolean;
  roundOf?: Round;
}
interface LineOp {
  kind: "line";
  opId: string;
  eid: string;
  p0: number;
  seg: Seg;
  fixed: boolean;
}
interface RoundOp {
  kind: "round";
  eid: string;
  c: Round;
  fixed: boolean;
}
type Operand = PointOp | LineOp | RoundOp;

/** Exported because SketchMode raises it for TEXT, which `pickEntity` never returns (no entitySegments). */
export const unsupportedMessage = (kind: string): string =>
  `A ${kind} can't be dimensioned yet, pick a line, arc, circle or rectangle edge.`;

const unsupported = (e: ResolvedEntity): DimError => ({
  error: "unsupported",
  message: unsupportedMessage(e.type),
});

const degenerate = (what: string): DimError => ({
  error: "degenerate",
  message: `That ${what} measures 0, nothing to drive.`,
});

/** A pick reduced to a point (id and `p` index) or a line operand. `p0` is the line's start point, corner k for a
 *  rect edge, which makes a parallel-lines distance work on rectangle sides. */
function reduce(t: DimTarget): Operand | DimError {
  const fixed = t.e.type === "projected";
  // Rim mode is silently inert on anything not round: the arm stays live until a round consumes it.
  if (t.kind !== "edge" && t.rim) {
    const rd = asRound(t.e);
    if (rd && centreIndex(t.e) !== null) {
      if (rd.r < MEASURE_EPS) return degenerate(t.e.type === "arc" ? "arc" : "circle");
      return { kind: "round", eid: t.e.id, c: rd, fixed };
    }
  }
  if (t.kind === "point") {
    // A picked round CENTRE is a round operand, or the shared centre of two concentric circles would report
    // coincident points instead of the concentric message.
    const round = centreIndex(t.e) === t.p;
    // Carry the round itself: two concentric circles have no centre distance, so the pair resolves to the radial gap.
    const rd0 = round ? asRound(t.e) : null;
    return { kind: "point", eid: t.e.id, p: t.p, pos: t.pos.clone(), round, fixed, ...(rd0 ? { roundOf: rd0 } : {}) };
  }
  if (t.kind === "edge") {
    return {
      kind: "line",
      opId: `${t.e.id}~${t.k}`,
      eid: t.e.id,
      p0: t.k,
      seg: { x1: t.a.x, y1: t.a.y, x2: t.b.x, y2: t.b.y },
      fixed,
    };
  }
  const e = t.e;
  const ls = asLineSeg(e);
  if (ls) {
    // asLineSeg returns the entity itself for a native line; copy the 4 coordinates so a Seg carries no id or type.
    const seg: Seg = { x1: ls.x1, y1: ls.y1, x2: ls.x2, y2: ls.y2 };
    return { kind: "line", opId: e.id, eid: e.id, p0: 0, seg, fixed };
  }
  const rd = asRound(e);
  const ci = centreIndex(e);
  if (rd && ci !== null) {
    return { kind: "point", eid: e.id, p: ci, pos: v(rd.x, rd.y), round: true, fixed, roundOf: rd };
  }
  return unsupported(e);
}

function buildPlan(spec: {
  kind: DimPlan["kind"];
  field: string;
  label: string;
  icon?: string;
  fieldKind: "length" | "angle";
  value: number;
  measureAt?: (cursor?: PlaceOffset) => number;
  anchors: { a: V; b: V } | null;
  labelAnchor: V | null;
  make: (value: number, place?: PlaceOffset, cursor?: PlaceOffset) => SketchConstraint;
  forceDriven?: boolean;
  parallelPair?: { l1: string; l2: string };
  implyConcentric?: { c1: string; c2: string };
  hint: string;
}): DimPlan {
  const fields: DimFieldDef[] = [
    { name: spec.field, label: spec.label, ...(spec.icon ? { icon: spec.icon } : {}), kind: spec.fieldKind },
  ];
  const anchors = spec.anchors;
  const labelAnchor = spec.labelAnchor;
  return {
    kind: spec.kind,
    field: spec.field,
    fields,
    fieldKey: `${spec.field}:${spec.fieldKind}`,
    measure: spec.measureAt ?? (() => spec.value),
    anchors: () => (anchors ? { a: anchors.a.clone(), b: anchors.b.clone() } : null),
    labelAnchor: () => labelAnchor?.clone() ?? null,
    make: spec.make,
    ...(spec.forceDriven ? { forceDriven: true } : {}),
    ...(spec.parallelPair ? { parallelPair: spec.parallelPair } : {}),
    ...(spec.implyConcentric ? { implyConcentric: spec.implyConcentric } : {}),
    hint: spec.hint,
  };
}

/** point to point, centre to centre and the edge length special case all land here */
function p2pPlan(a: PointOp, b: PointOp, forceDriven: boolean, hint: string): DimPlan {
  const anchor = mid(a.pos, b.pos);
  const modeOf = (off?: PlaceOffset) =>
    off ? axisModeAt(a.pos, b.pos, v(anchor.x + off.ox, anchor.y + off.oy)) : "aligned";
  return buildPlan({
    kind: "distance",
    field: "distance",
    label: "D",
    fieldKind: "length",
    value: a.pos.distanceTo(b.pos),
    measureAt: (off) => axisMeasure(a.pos, b.pos, modeOf(off)),
    anchors: { a: a.pos, b: b.pos },
    labelAnchor: anchor,
    forceDriven,
    hint,
    make: (value, place, cursor) => {
      const mode = modeOf(place ?? cursor);
      if (mode !== "aligned") return axisDim(mode, a, b, value, place);
      return {
        type: "p2pDistance",
        e1: a.eid,
        p1: a.p,
        e2: b.eid,
        p2: b.p,
        value,
        ...(place ? { place } : {}),
      };
    },
  });
}

export type AxisMode = "aligned" | "h" | "v";

/** Beside the pair (outside its x range, inside its y range) measures vertically, above or below horizontally,
 *  anywhere else aligned. A mode that would read 0, or the same as aligned, stays aligned. */
export function axisModeAt(a: V, b: V, cursor: V): AxisMode {
  const outX = cursor.x < Math.min(a.x, b.x) || cursor.x > Math.max(a.x, b.x);
  const outY = cursor.y < Math.min(a.y, b.y) || cursor.y > Math.max(a.y, b.y);
  const mode: AxisMode = outX && !outY ? "v" : outY && !outX ? "h" : "aligned";
  if (mode === "aligned") return mode;
  const m = axisMeasure(a, b, mode);
  return m < MEASURE_EPS || a.distanceTo(b) - m < MEASURE_EPS ? "aligned" : mode;
}

export function axisMeasure(a: V, b: V, mode: AxisMode): number {
  return mode === "h" ? Math.abs(b.x - a.x) : mode === "v" ? Math.abs(b.y - a.y) : a.distanceTo(b);
}

/** e2 is the operand further along the axis, so the stored signed value is positive */
function axisDim(mode: "h" | "v", a: PointOp, b: PointOp, value: number, place?: PlaceOffset): SketchConstraint {
  const k = mode === "h" ? "x" : "y";
  const [lo, hi] = a.pos[k] <= b.pos[k] ? [a, b] : [b, a];
  return {
    type: mode === "h" ? "hDistance" : "vDistance",
    e1: lo.eid,
    p1: lo.p,
    e2: hi.eid,
    p2: hi.p,
    value,
    ...(place ? { place } : {}),
  };
}

function p2lPlan(
  pt: PointOp,
  ln: LineOp,
  forceDriven: boolean,
  hint: string,
  parallelPair?: { l1: string; l2: string },
): DimPlan {
  const foot = footOf(pt.pos, ln.seg);
  return buildPlan({
    kind: "distance",
    field: "distance",
    label: "D",
    fieldKind: "length",
    value: perpDist(pt.pos, ln.seg),
    anchors: { a: pt.pos, b: foot },
    labelAnchor: mid(pt.pos, foot),
    forceDriven,
    ...(parallelPair ? { parallelPair } : {}),
    hint,
    make: (value, place) => ({
      type: "p2lDistance",
      e: pt.eid,
      p: pt.p,
      line: ln.opId,
      value,
      ...(place ? { place } : {}),
    }),
  });
}

// Every rim measure and annotation comes from entityDims, which the solve guard re-checks too.

/** Concentric gives the SIGNED radial gap on planegcs `difference`, the only form that cannot solve an annulus
 *  inside out. Otherwise the minimum clearance on `c2cdistance`; overlapping rims are refused. */
function roundRoundPlan(a: RoundOp, b: RoundOp, forceDriven: boolean, drivenHint: string): DimResolution {
  // Two picks can name one circle (its rim and its centre); without this the radial gap branch reports the wrong thing.
  if (a.eid === b.eid) {
    return { error: "same-entity", message: "That is one circle picked twice, pick a second entity to measure to." };
  }
  const d = Math.hypot(b.c.x - a.c.x, b.c.y - a.c.y);
  if (d < MEASURE_EPS) {
    const gap = Math.abs(b.c.r - a.c.r);
    if (gap < MEASURE_EPS) {
      return { error: "degenerate", message: "These two rims are the same circle, the radial gap measures 0." };
    }
    const inner = a.c.r <= b.c.r ? a : b;
    const outer = a.c.r <= b.c.r ? b : a;
    const pts = radialGapPoints(inner.c, outer.c, v(1, 0));
    const innerId = inner.eid,
      outerId = outer.eid;
    return buildPlan({
      kind: "distance",
      field: "gap",
      label: "Gap",
      fieldKind: "length",
      value: gap,
      anchors: pts,
      labelAnchor: mid(pts.a, pts.b),
      forceDriven,
      implyConcentric: { c1: innerId, c2: outerId },
      hint: `Radial gap (wall thickness): type a value · click to place${drivenHint}`,
      make: (value, place) => ({
        type: "radialGap",
        inner: innerId,
        outer: outerId,
        value,
        ...(place ? { place } : {}),
      }),
    });
  }
  const gap = rimGap(a.c, b.c);
  const sum = a.c.r + b.c.r;
  const diff = Math.abs(a.c.r - b.c.r);
  // Classify from the geometry, not rimGap's sign: its branches jump at internal tangency.
  if (Math.abs(d - sum) < MEASURE_EPS || Math.abs(d - diff) < MEASURE_EPS) {
    return {
      error: "degenerate",
      message: "These two rims touch, the edge-to-edge distance measures 0, nothing to drive.",
    };
  }
  if (d > diff && d < sum) {
    return {
      error: "overlapping",
      message:
        "These two circles overlap, there is no edge-to-edge clearance to dimension. " +
        "Dimension their centres, or each diameter.",
    };
  }
  const nested = d < diff;
  // Ordered by operand id, not pick order, so dimensioning the pair the other way round REPLACES the dim.
  const [o1, o2] = a.eid <= b.eid ? [a, b] : [b, a];
  const pts = rimGapPoints(a.c, b.c, v(1, 0));
  const id1 = o1.eid,
    id2 = o2.eid;
  return buildPlan({
    kind: "distance",
    field: "distance",
    label: "D",
    fieldKind: "length",
    value: gap,
    anchors: pts,
    labelAnchor: mid(pts.a, pts.b),
    forceDriven,
    hint: `${nested ? "Minimum radial clearance" : "Edge-to-edge clearance"}: type a value · click to place${drivenHint}`,
    make: (value, place) => ({
      type: "c2cDistance",
      c1: id1,
      c2: id2,
      value,
      ...(place ? { place } : {}),
    }),
  });
}

/** planegcs `c2ldistance` = |perp(centre, line)| - r. A line crossing the circle is refused rather than driven
 *  negative, which the solver would satisfy by flipping. */
function roundLinePlan(rd: RoundOp, ln: LineOp, forceDriven: boolean, drivenHint: string): DimResolution {
  if (segLen(ln.seg) < MEASURE_EPS) return degenerate("line");
  const pts = lineRimPoints(ln.seg, rd.c);
  if (!pts) {
    return {
      error: "point-on-line",
      message: "That circle's centre lies on the line, there is no edge-to-edge distance to dimension.",
    };
  }
  const gap = perpDist(rd.c, ln.seg) - rd.c.r;
  if (gap < -MEASURE_EPS) {
    return {
      error: "crossing",
      message:
        "That line crosses the circle, there is no edge-to-edge distance to dimension. " +
        "Dimension the centre to the line instead.",
    };
  }
  if (gap < MEASURE_EPS) {
    return {
      error: "degenerate",
      message: "That line is tangent to the circle, the edge-to-edge distance measures 0, nothing to drive.",
    };
  }
  const cid = rd.eid,
    lid = ln.opId;
  return buildPlan({
    kind: "distance",
    field: "distance",
    label: "D",
    fieldKind: "length",
    value: gap,
    anchors: pts,
    labelAnchor: mid(pts.a, pts.b),
    forceDriven,
    hint: `Edge-to-line distance: type a value · click to place${drivenHint}`,
    make: (value, place) => ({
      type: "c2lDistance",
      circle: cid,
      line: lid,
      value,
      ...(place ? { place } : {}),
    }),
  });
}

/** planegcs `p2cdistance` = |dist(p, centre) - r|, from either side; the solve guard keeps the point on its side. */
function pointRoundPlan(pt: PointOp, rd: RoundOp, forceDriven: boolean, drivenHint: string): DimResolution {
  const d = Math.hypot(pt.pos.x - rd.c.x, pt.pos.y - rd.c.y);
  if (d < MEASURE_EPS) {
    return {
      error: "coincident-points",
      message:
        "That point sits at the circle's centre, the distance to its edge IS its radius, " +
        "so dimension the radius instead.",
    };
  }
  const gap = Math.abs(d - rd.c.r);
  if (gap < MEASURE_EPS) {
    return {
      error: "degenerate",
      message: "That point lies on the circle, the distance to the edge measures 0, nothing to drive.",
    };
  }
  const pts = pointRimPoints(pt.pos, rd.c);
  if (!pts) return degenerate("circle");
  const eid = pt.eid,
    p = pt.p,
    cid = rd.eid;
  return buildPlan({
    kind: "distance",
    field: "distance",
    label: "D",
    fieldKind: "length",
    value: gap,
    anchors: pts,
    labelAnchor: mid(pts.a, pts.b),
    forceDriven,
    hint: `Point-to-edge distance: type a value · click to place${drivenHint}`,
    make: (value, place) => ({
      type: "p2cDistance",
      e: eid,
      p,
      circle: cid,
      value,
      ...(place ? { place } : {}),
    }),
  });
}

/** Pure: every input is in the targets, every failure a named DimError with its own toast text. */
export function resolveDim(picks: DimTarget[], opts: DimOptions = {}): DimResolution {
  const [t1, t2] = picks;
  if (!t1) return { error: "need-second", message: "", keepPicks: true };
  if (!t2) return resolveSingle(t1, opts);
  if (targetKey(t1) === targetKey(t2)) return { error: "same-entity", message: "" };
  return resolvePair(t1, t2, opts.reflex === true);
}

function resolveSingle(t: DimTarget, opts: DimOptions): DimResolution {
  const e = t.e;
  if (t.kind === "edge") {
    const len = t.a.distanceTo(t.b);
    if (len < MEASURE_EPS) return degenerate("edge");
    // a rectangle edge's length IS the distance between its two corners
    const a: PointOp = { kind: "point", eid: e.id, p: t.k, pos: t.a, round: false, fixed: false };
    const b: PointOp = { kind: "point", eid: e.id, p: (t.k + 1) % 4, pos: t.b, round: false, fixed: false };
    return p2pPlan(a, b, false, "Rectangle edge: type a length, or pick a second entity · click to place");
  }
  if (t.kind === "point") {
    return {
      error: "need-second",
      keepPicks: true,
      message:
        e.type === "projected" ? PROJECTED_PAIR_MSG : "Pick a second point, or a line, for the distance between them",
    };
  }
  // whole-entity pick
  if (e.type === "projected") {
    // fixed reference geometry has no driving dim of its own but is a valid pair operand, so stay armed
    return { error: "projected-single", keepPicks: true, message: PROJECTED_PAIR_MSG };
  }
  const ls = asLineSeg(e);
  if (ls) {
    const len = Math.hypot(ls.x2 - ls.x1, ls.y2 - ls.y1);
    if (len < MEASURE_EPS) return degenerate("line");
    const a = v(ls.x1, ls.y1),
      b = v(ls.x2, ls.y2);
    const eid = e.id;
    const anchor = mid(a, b);
    const modeOf = (off?: PlaceOffset) => (off ? axisModeAt(a, b, v(anchor.x + off.ox, anchor.y + off.oy)) : "aligned");
    const pa: PointOp = { kind: "point", eid, p: 0, pos: a, round: false, fixed: false };
    const pb: PointOp = { kind: "point", eid, p: 1, pos: b, round: false, fixed: false };
    return buildPlan({
      kind: "length",
      field: "length",
      label: "L",
      fieldKind: "length",
      value: len,
      measureAt: (off) => axisMeasure(a, b, modeOf(off)),
      anchors: { a, b },
      // the aligned `distance` renders through the line's badge and drops `place`
      labelAnchor: anchor,
      hint: "Line: type a length, or pick a second entity · click to place",
      make: (value, place, cursor) => {
        const mode = modeOf(place ?? cursor);
        return mode === "aligned" ? { type: "distance", line: eid, value } : axisDim(mode, pa, pb, value, place);
      },
    });
  }
  if (e.type === "circle") {
    if (e.radius < MEASURE_EPS) return degenerate("circle");
    const eid = e.id;
    if (opts.roundPref === "radius") return roundValuePlan(eid, e.radius, v(e.x, e.y), "Circle");
    return buildPlan({
      kind: "diameter",
      field: "diameter",
      label: "Diameter",
      icon: "diameter",
      fieldKind: "length",
      value: e.radius * 2,
      anchors: { a: v(e.x - e.radius, e.y), b: v(e.x + e.radius, e.y) },
      labelAnchor: null, // `diameter` renders through entityDims, no place slot
      hint: "Circle: type a diameter, or pick a second entity · click to place",
      make: (value) => ({ type: "diameter", circle: eid, value }),
    });
  }
  if (e.type === "arc") {
    const rd = asRound(e);
    if (!rd || rd.r < MEASURE_EPS) return degenerate("arc");
    const eid = e.id;
    const c = v(rd.x, rd.y);
    if (opts.roundPref === "diameter") {
      return buildPlan({
        kind: "diameter",
        field: "diameter",
        label: "Diameter",
        icon: "diameter",
        fieldKind: "length",
        value: rd.r * 2,
        anchors: { a: v(rd.x - rd.r, rd.y), b: v(rd.x + rd.r, rd.y) },
        labelAnchor: c,
        hint: "Arc: type a diameter, or pick a second entity · click to place",
        make: (value, place) => ({ type: "diameter", circle: eid, value, ...(place ? { place } : {}) }),
      });
    }
    return roundValuePlan(eid, rd.r, c, "Arc");
  }
  return unsupported(e);
}

/** shared by an arc (its default) and a circle whose override asked for a radius */
function roundValuePlan(eid: string, r: number, c: V, what: string): DimPlan {
  return buildPlan({
    kind: "radius",
    field: "radius",
    label: "R",
    fieldKind: "length",
    value: r,
    anchors: { a: c, b: v(c.x + r * Math.SQRT1_2, c.y + r * Math.SQRT1_2) },
    labelAnchor: c,
    hint: `${what}: type a radius, or pick a second entity · click to place`,
    make: (value, place) => ({ type: "radius", e: eid, value, ...(place ? { place } : {}) }),
  });
}

function resolvePair(t1: DimTarget, t2: DimTarget, reflex = false): DimResolution {
  const o1 = reduce(t1);
  if ("error" in o1) return o1;
  const o2 = reduce(t2);
  if ("error" in o2) return o2;
  const a = o1,
    b = o2;
  // Both operands fixed means nothing can move, so make a driven dim instead of an unsatisfiable one.
  const forceDriven = a.fixed && b.fixed;
  const drivenHint = forceDriven ? " · reference geometry, created as a driven dimension" : "";
  // rim (tangent) rows: at least one operand contributes its edge
  if (a.kind === "round" || b.kind === "round") {
    const rd = a.kind === "round" ? a : (b as RoundOp);
    const other = a.kind === "round" ? b : a;
    if (other.kind === "round") return roundRoundPlan(rd, other, forceDriven, drivenHint);
    if (other.kind === "line") return roundLinePlan(rd, other, forceDriven, drivenHint);
    if (other.eid === rd.eid) {
      // the round's own centre picked alongside its rim: that is its radius
      return {
        error: "same-entity",
        message: "That is the circle's own centre and rim, dimension its radius instead.",
      };
    }
    return pointRoundPlan(other, rd, forceDriven, drivenHint);
  }
  if (a.kind === "point" && b.kind === "point") {
    if (a.eid === b.eid && a.p === b.p) return { error: "same-entity", message: "" };
    const d = a.pos.distanceTo(b.pos);
    if (d < MEASURE_EPS) {
      // Two CONCENTRIC rounds have a centre distance of 0 forever, so the radial gap is the only meaningful dimension.
      if (a.roundOf && b.roundOf && a.eid !== b.eid) {
        return roundRoundPlan(
          { kind: "round", eid: a.eid, c: a.roundOf, fixed: a.fixed },
          { kind: "round", eid: b.eid, c: b.roundOf, fixed: b.fixed },
          forceDriven,
          drivenHint,
        );
      }
      return a.round && b.round
        ? { error: "concentric", message: CONCENTRIC_MSG }
        : {
            error: "coincident-points",
            message: "Those two points are coincident, the distance measures 0, nothing to drive.",
          };
    }
    return p2pPlan(a, b, forceDriven, `Distance: type a value · click to place${drivenHint}`);
  }
  if (a.kind === "point" || b.kind === "point") {
    const pt = a.kind === "point" ? a : (b as PointOp);
    const ln = a.kind === "line" ? a : (b as LineOp);
    if (segLen(ln.seg) < MEASURE_EPS) return degenerate("line");
    if (perpDist(pt.pos, ln.seg) < MEASURE_EPS) {
      return {
        error: "point-on-line",
        message: "That point lies on the line, the distance measures 0, nothing to drive.",
      };
    }
    return p2lPlan(pt, ln, forceDriven, `Distance to line: type a value · click to place${drivenHint}`);
  }
  return lineLine(a, b, forceDriven, drivenHint, reflex);
}

function lineLine(l1: LineOp, l2: LineOp, forceDriven: boolean, drivenHint: string, reflex = false): DimResolution {
  if (l1.opId === l2.opId) return { error: "same-entity", message: "" };
  const d1 = dirOf(l1.seg),
    d2 = dirOf(l2.seg);
  if (!d1 || !d2) return degenerate("line");
  const sinT = Math.abs(d1.x * d2.y - d1.y * d2.x);
  if (sinT >= PARALLEL_EPS) {
    const s1 = l1.seg,
      s2 = l2.seg;
    const m1 = v((s1.x1 + s1.x2) / 2, (s1.y1 + s1.y2) / 2);
    const m2 = v((s2.x1 + s2.x2) / 2, (s2.y1 + s2.y2) / 2);
    const id1 = l1.opId,
      id2 = l2.opId;
    const anchor = mid(m1, m2);
    const wedgeOf = (off?: PlaceOffset) =>
      off ? wedgeAt(s1, s2, v(anchor.x + off.ox, anchor.y + off.oy), reflex) : null;
    return buildPlan({
      kind: "angle",
      field: "angle",
      label: "Angle",
      icon: "angle",
      fieldKind: "angle",
      value: signedAngleDeg(s1, s2),
      measureAt: (off) => wedgeOf(off)?.value ?? signedAngleDeg(s1, s2),
      anchors: null,
      labelAnchor: anchor,
      forceDriven,
      hint: `Angle: type the included angle · click to place, right-click for the reflex angle${drivenHint}`,
      make: (value, place, cursor) => {
        const w = wedgeOf(place ?? cursor);
        if (!w) return { type: "angle", l1: id1, l2: id2, value, ...(place ? { place } : {}) };
        return {
          type: "angle",
          l1: w.swap ? id2 : id1,
          l2: w.swap ? id1 : id2,
          value,
          rays: w.rays,
          ...(place ? { place } : {}),
        };
      },
    });
  }
  // Parallel lines get the perpendicular distance, not a 0 deg angle. The anchor line is chosen by operand id so the
  // p2lDistance dedup replaces a dim made the other way round; `parallelPair` stops the pair rotating to meet it.
  // Two sides of one rectangle are already held parallel.
  const [pl, ll] = l1.opId <= l2.opId ? [l1, l2] : [l2, l1];
  const pt: PointOp = {
    kind: "point",
    eid: pl.eid,
    p: pl.p0,
    pos: v(pl.seg.x1, pl.seg.y1),
    round: false,
    fixed: pl.fixed,
  };
  if (perpDist(pt.pos, ll.seg) < MEASURE_EPS) {
    return { error: "point-on-line", message: "Those lines are collinear, the distance measures 0, nothing to drive." };
  }
  const pair = pl.eid === ll.eid ? undefined : { l1: pl.opId, l2: ll.opId };
  return p2lPlan(pt, ll, forceDriven, `Parallel lines: type the distance · click to place${drivenHint}`, pair);
}
