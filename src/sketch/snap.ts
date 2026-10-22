// Snap candidates are compared to the cursor in screen pixels so the radius is zoom-independent, the grid is the
// low-priority fallback.

import * as THREE from "three";
import type { DimPlace, ProjectedCurve, ProjectedSource, SketchConstraint } from "../types";
import { asRound } from "./entityDims";
import { rectCorners } from "./region";
import type { SketchPlane } from "./plane";

export type SnapKind = "free" | "grid" | "endpoint" | "midpoint" | "center" | "control" | "curve" | "align";

/** Endpoint index (dimPoint numbering), midpoint or nearest point on a curve. Only set for entities the solver can
 *  hold a relation to. */
export interface SnapRef {
  entity: string;
  at: number | "mid" | "curve";
}

export type SnapCurve =
  | { entity: string; kind: "line"; x1: number; y1: number; x2: number; y2: number }
  | { entity: string; kind: "circle"; cx: number; cy: number; r: number }
  // a0 to a1 counterclockwise, radians
  | { entity: string; kind: "arc"; cx: number; cy: number; r: number; a0: number; a1: number };

export interface SnapCandidate {
  p: THREE.Vector2;
  kind: SnapKind;
  priority: number; // higher is preferred
  /** What the anchor is, named beside the marker ("Face Center"). */
  label?: string | undefined;
  /** Names of the lines through this anchor along the sketch's x and y ("X Axis"). */
  lineLabels?: { x: string; y: string } | undefined;
  ref?: SnapRef | undefined;
}

/** `axis: "x"` means the cursor took the anchor's x, standing on its vertical line. */
export interface SnapGuide {
  from: THREE.Vector2;
  axis: "x" | "y";
}

export interface SnapResult {
  point: THREE.Vector2;
  kind: SnapKind;
  /** Empty for every kind but "align". */
  guides: SnapGuide[];
  label?: string | undefined;
  ref?: SnapRef | undefined;
}

export function snap(
  raw: THREE.Vector2,
  candidates: SnapCandidate[],
  toScreen: (p: THREE.Vector2) => { x: number; y: number },
  gridStep: number,
  pixelTol = 10,
  curves: readonly SnapCurve[] = [],
): SnapResult {
  const rawScreen = toScreen(raw);
  const screenGap = (p: THREE.Vector2) => {
    const s = toScreen(p);
    return Math.hypot(s.x - rawScreen.x, s.y - rawScreen.y);
  };
  let best: SnapCandidate | null = null;
  let bestD = pixelTol;
  // Row and column alignment are gathered in this one loop, a second walk would cost three projections per candidate.
  let alignX: { c: SnapCandidate; d: number } | null = null;
  let alignY: { c: SnapCandidate; d: number } | null = null;

  for (const c of candidates) {
    const s = toScreen(c.p);
    const d = Math.hypot(s.x - rawScreen.x, s.y - rawScreen.y);
    if (d <= pixelTol) {
      // within tolerance: prefer higher priority, then nearer
      if (!best || c.priority > best.priority || (c.priority === best.priority && d < bestD)) {
        best = c;
        bestD = d;
      }
    }
    // Full screen distance to (anchor x, cursor y), like the grid fallback: the same reach at every zoom, and with Lock
    // to Plane off a sketch axis is neither screen axis.
    const dx = screenGap(new THREE.Vector2(c.p.x, raw.y));
    if (dx <= pixelTol && (!alignX || dx < alignX.d)) alignX = { c, d: dx };
    const dy = screenGap(new THREE.Vector2(raw.x, c.p.y));
    if (dy <= pixelTol && (!alignY || dy < alignY.d)) alignY = { c, d: dy };
  }

  if (best) return { point: best.p.clone(), kind: best.kind, guides: [], label: snapLabel(best), ref: best.ref };

  // Each axis snaps to the grid on its own, so anywhere along a grid line snaps and an intersection is both firing.
  // Full screen distance per axis (see screenGap). Computed before alignment, which can leave one axis free.
  const gridAxis = (): { x: number | null; y: number | null } => {
    if (gridStep <= 0) return { x: null, y: null }; // grid snap off
    const gx = Math.round(raw.x / gridStep) * gridStep;
    const gy = Math.round(raw.y / gridStep) * gridStep;
    return {
      x: screenGap(new THREE.Vector2(gx, raw.y)) <= pixelTol ? gx : null,
      y: screenGap(new THREE.Vector2(raw.x, gy)) <= pixelTol ? gy : null,
    };
  };

  // On a curve ranks below point anchors and above alignment. A lattice point on the curve beats the nearest point, so
  // a grid aligned line still takes the grid's coordinates.
  let onCurve: { p: THREE.Vector2; d: number; cv: SnapCurve } | null = null;
  for (const cv of curves) {
    const f = nearestOnCurve(cv, raw);
    if (!f) continue;
    const d = screenGap(f);
    if (d <= pixelTol && (!onCurve || d < onCurve.d)) onCurve = { p: f, d, cv };
  }
  if (onCurve) {
    const g = gridAxis();
    let point = onCurve.p;
    if (g.x !== null || g.y !== null) {
      const lattice = new THREE.Vector2(g.x ?? point.x, g.y ?? point.y);
      const back = nearestOnCurve(onCurve.cv, lattice);
      if (back && back.distanceTo(lattice) <= 1e-9 * Math.max(1, gridStep)) point = lattice;
    }
    return { point, kind: "curve", guides: [], label: "On Curve", ref: { entity: onCurve.cv.entity, at: "curve" } };
  }

  // Alignment ranks above the grid, being a statement about the drawing, and below a point: on an anchor, the anchor
  // is the answer.
  if (alignX || alignY) {
    // Both axes from the same anchor: the cursor is diagonally near it outside the point tolerance. Snap to it, but not
    // as an alignment with two zero-length guides.
    if (alignX && alignY && alignX.c === alignY.c) {
      return {
        point: alignX.c.p.clone(),
        kind: alignX.c.kind,
        guides: [],
        label: snapLabel(alignX.c),
        ref: alignX.c.ref,
      };
    }
    const guides: SnapGuide[] = [];
    if (alignX) guides.push({ from: alignX.c.p.clone(), axis: "x" });
    if (alignY) guides.push({ from: alignY.c.p.clone(), axis: "y" });
    // The axis alignment did not answer still gets the grid's answer, else a vertex aligned with a corner keeps a raw
    // coordinate in the other axis (20.0000 by 5.0072 on a 1mm grid).
    const g = gridAxis();
    // Lined up on x means standing on the anchor's vertical line, its y line.
    const line = alignX && !alignY ? alignX.c.lineLabels?.y : alignY && !alignX ? alignY.c.lineLabels?.x : undefined;
    return {
      point: new THREE.Vector2(alignX ? alignX.c.p.x : (g.x ?? raw.x), alignY ? alignY.c.p.y : (g.y ?? raw.y)),
      kind: "align",
      guides,
      ...(line ? { label: line } : {}),
    };
  }

  const g = gridAxis();
  if (g.x !== null || g.y !== null) {
    return {
      point: new THREE.Vector2(g.x ?? raw.x, g.y ?? raw.y),
      kind: "grid",
      guides: [],
    };
  }

  return { point: raw.clone(), kind: "free", guides: [] };
}

const KIND_LABEL: Partial<Record<SnapKind, string>> = {
  endpoint: "Endpoint",
  midpoint: "Midpoint",
  center: "Center",
  control: "Control Point",
};

/** The name shown beside a snapped anchor: its own, or its kind's. */
export function snapLabel(c: Pick<SnapCandidate, "kind" | "label">): string | undefined {
  return c.label ?? KIND_LABEL[c.kind];
}

/** Under the select tool only real geometry anchors (endpoint, midpoint, centre) get a marker, since nothing is placed
 *  and those are what a click grabs. Every other tool places a point and wants the whole lattice. */
export function showsSnapMarker(tool: string, kind: SnapKind, label?: string): boolean {
  if (kind === "free") return false;
  if (tool !== "select") return true;
  return (
    kind === "endpoint" ||
    kind === "midpoint" ||
    kind === "center" ||
    kind === "control" ||
    (kind === "align" && !!label)
  );
}

/** The world origin as a snap anchor, when the sketch plane passes through it. */
export function originCandidate(plane: SketchPlane): SnapCandidate[] {
  const origin = new THREE.Vector3();
  if (Math.abs(plane.n.dot(origin.clone().sub(plane.origin))) > 1e-6) return [];
  return [
    {
      p: plane.to2D(origin),
      kind: "center",
      priority: 95,
      label: "Origin",
      lineLabels: { x: axisName(plane.u), y: axisName(plane.v) },
    },
  ];
}

/** "X Axis" for a direction along a world axis, else a plain name for the line. */
function axisName(dir: THREE.Vector3): string {
  const names = ["X", "Y", "Z"] as const;
  const c = [dir.x, dir.y, dir.z];
  const i = c.findIndex((v) => Math.abs(Math.abs(v) - 1) < 1e-6);
  return i >= 0 ? `${names[i]} Axis` : "Axis";
}

/** Shared by the dimension tool and pinOriginPoint so the two agree on what counts as already pinned here. */
export function existingFixedPoint(
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
  pos: THREE.Vector2,
): Extract<ResolvedEntity, { type: "point" }> | null {
  const fixed = new Set(
    constraints.filter((c): c is Extract<SketchConstraint, { type: "fix" }> => c.type === "fix").map((c) => c.e),
  );
  for (const e of entities) {
    if (e.type === "point" && fixed.has(e.id) && Math.hypot(e.x - pos.x, e.y - pos.y) < 1e-6) return e;
  }
  return null;
}

/** Called only when a drawing click SNAPS to the origin, never on hover. Needs no coincident: sketchSolve merges
 *  same-position points (coincKey), so a corner here shares this point's id and `fix`, and a second one reuses it.
 *  Without it a corner on the origin was free for the next solve to move (SK-6). */
export function pinOriginPoint(
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
  pos: THREE.Vector2,
  newId: () => string,
): Extract<ResolvedEntity, { type: "point" }> {
  const existing = existingFixedPoint(entities, constraints, pos);
  if (existing) return existing;
  const point: Extract<ResolvedEntity, { type: "point" }> = {
    type: "point",
    id: newId(),
    x: pos.x,
    y: pos.y,
    construction: true,
  };
  entities.push(point);
  constraints.push({ type: "fix", e: point.id, p: 0 });
  return point;
}

/** The pin is only made once the shape commits (the entity list grew past `count`), so a cancelled shape leaves no
 *  point behind (SK-10). */
export type OriginPinRequest = { at: THREE.Vector2; count: number };

/** Returns the request still waiting, or null once settled. */
export function settleOriginPin(
  req: OriginPinRequest | null,
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
  newId: () => string,
): OriginPinRequest | null {
  if (!req || entities.length <= req.count) return req;
  pinOriginPoint(entities, constraints, req.at, newId);
  return null;
}

/** null follows the cursor. Grid and plain alignment are left out, a drag stepping along the lattice stops feeling
 *  like a drag. */
export function dragSnap(
  raw: THREE.Vector2,
  candidates: SnapCandidate[],
  toScreen: (p: THREE.Vector2) => { x: number; y: number },
  pixelTol = 10,
): SnapResult | null {
  const res = snap(raw, candidates, toScreen, 0, pixelTol);
  // A named line (an axis through the origin) is a real place to drop a point.
  if (res.kind === "align" && res.label) return res;
  return res.kind === "endpoint" || res.kind === "midpoint" || res.kind === "center" || res.kind === "control"
    ? res
    : null;
}

/** The nearest point of `cv` to `q`, or null when it falls past an arc's ends. */
export function nearestOnCurve(cv: SnapCurve, q: THREE.Vector2): THREE.Vector2 | null {
  if (cv.kind === "line") {
    const dx = cv.x2 - cv.x1,
      dy = cv.y2 - cv.y1;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-18) return null;
    const t = Math.min(1, Math.max(0, ((q.x - cv.x1) * dx + (q.y - cv.y1) * dy) / L2));
    return new THREE.Vector2(cv.x1 + t * dx, cv.y1 + t * dy);
  }
  const vx = q.x - cv.cx,
    vy = q.y - cv.cy;
  const len = Math.hypot(vx, vy);
  if (len < 1e-12 || !(cv.r > 0)) return null;
  if (cv.kind === "arc") {
    const tau = 2 * Math.PI;
    const sweep = (((cv.a1 - cv.a0) % tau) + tau) % tau;
    const along = (((Math.atan2(vy, vx) - cv.a0) % tau) + tau) % tau;
    if (along > sweep) return null;
  }
  return new THREE.Vector2(cv.cx + (vx / len) * cv.r, cv.cy + (vy / len) * cv.r);
}

/** The curves a pointOnCurve relation can hold a point to: native lines, circles and arcs. */
export function curvesFromEntities(entities: ResolvedEntity[]): SnapCurve[] {
  const out: SnapCurve[] = [];
  for (const e of entities) {
    if (e.type === "line") out.push({ entity: e.id, kind: "line", x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 });
    else if (e.type === "circle") out.push({ entity: e.id, kind: "circle", cx: e.x, cy: e.y, r: e.radius });
    else if (e.type === "arc") {
      const r = asRound(e);
      if (!r) continue;
      const ang = (x: number, y: number) => Math.atan2(y - r.y, x - r.x);
      const ccw = (e.mx - e.x1) * (e.y2 - e.my) - (e.my - e.y1) * (e.x2 - e.mx) > 0;
      const [a0, a1] = ccw ? [ang(e.x1, e.y1), ang(e.x2, e.y2)] : [ang(e.x2, e.y2), ang(e.x1, e.y1)];
      out.push({ entity: e.id, kind: "arc", cx: r.x, cy: r.y, r: r.r, a0, a1 });
    }
  }
  return out;
}

export function candidatesFromEntities(entities: ResolvedEntity[]): SnapCandidate[] {
  const out: SnapCandidate[] = [];
  const add = (x: number, y: number, kind: SnapKind, priority: number, ref?: SnapRef) =>
    out.push({ p: new THREE.Vector2(x, y), kind, priority, ...(ref ? { ref } : {}) });

  for (const e of entities) {
    if (e.type === "line") {
      add(e.x1, e.y1, "endpoint", 100, { entity: e.id, at: 0 });
      add(e.x2, e.y2, "endpoint", 100, { entity: e.id, at: 1 });
      add((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2, "midpoint", 80, { entity: e.id, at: "mid" });
    } else if (e.type === "rectangle") {
      // Through rectCorners so a rotated rectangle snaps to where it is drawn, inline corners would drift apart.
      const c = rectCorners(e.x, e.y, e.width, e.height, e.angle);
      c.forEach((p, k) => add(p.x, p.y, "endpoint", 100, { entity: e.id, at: k }));
      add(e.x, e.y, "center", 90);
      for (let k = 0; k < 4; k++) {
        const a = c[k]!;
        const b = c[(k + 1) % 4]!;
        add((a.x + b.x) / 2, (a.y + b.y) / 2, "midpoint", 80);
      }
    } else if (e.type === "circle") {
      add(e.x, e.y, "center", 90, { entity: e.id, at: 0 });
    } else if (e.type === "arc") {
      add(e.x1, e.y1, "endpoint", 100, { entity: e.id, at: 0 });
      add(e.x2, e.y2, "endpoint", 100, { entity: e.id, at: 1 });
      add(e.mx, e.my, "midpoint", 80);
    } else if (e.type === "spline") {
      for (const p of e.points) add(p.x, p.y, "endpoint", 100); // fit points snap
    } else if (e.type === "bspline") {
      const last = e.poles.length - 1;
      e.poles.forEach((p, k) => {
        const end = !e.closed && (k === 0 || k === last);
        add(p.x, p.y, end ? "endpoint" : "control", end ? 100 : 60);
      });
    } else if (e.type === "point") {
      add(e.x, e.y, "endpoint", 110, { entity: e.id, at: 0 }); // a placed point is a strong snap target
    } else if (e.type === "projected") {
      // Projected curves snap like native ones. Centers come from asRound, poly interior vertices are samples so they
      // snap weakly (60).
      const round = asRound(e);
      if (round) add(round.x, round.y, "center", 90);
      const cv = e.curve;
      if (cv.kind === "line") {
        add(cv.x1, cv.y1, "endpoint", 100);
        add(cv.x2, cv.y2, "endpoint", 100);
        add((cv.x1 + cv.x2) / 2, (cv.y1 + cv.y2) / 2, "midpoint", 80);
      } else if (cv.kind === "arc") {
        add(cv.x1, cv.y1, "endpoint", 100);
        add(cv.x2, cv.y2, "endpoint", 100);
        add(cv.mx, cv.my, "midpoint", 80); // exact model point, same as native arcs
      } else if (cv.kind === "poly") {
        const pts = cv.pts;
        pts.forEach(([x, y], i) => {
          const isEnd = i === 0 || i === pts.length - 1;
          add(x, y, "endpoint", isEnd ? 100 : 60);
        });
      }
    }
  }
  return out;
}

// `id` is the stable in-session identity constraints reference (see ./id.ts). `dimPlace` is plain numbers, a
// structural copy through resolution.
export type ResolvedEntity =
  | {
      type: "line";
      id: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      construction?: boolean;
      dimPlace?: DimPlace;
    }
  | {
      type: "rectangle";
      id: string;
      width: number;
      height: number;
      x: number;
      y: number;
      angle?: number;
      construction?: boolean;
      dimPlace?: DimPlace;
    }
  | { type: "circle"; id: string; radius: number; x: number; y: number; construction?: boolean; dimPlace?: DimPlace }
  | {
      type: "arc";
      id: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      mx: number;
      my: number;
      construction?: boolean;
    }
  | { type: "spline"; id: string; points: { x: number; y: number }[]; construction?: boolean }
  | {
      type: "bspline";
      id: string;
      poles: { x: number; y: number }[];
      degree?: number;
      closed?: boolean;
      knots?: number[];
      construction?: boolean;
    }
  | { type: "point"; id: string; x: number; y: number; construction?: boolean }
  // parametric shapes (rigid: the solver skips them; edited via their params)
  | {
      type: "polygon";
      id: string;
      x: number;
      y: number;
      radius: number;
      sides: number;
      angle: number;
      construction?: boolean;
      dimPlace?: DimPlace;
    }
  | {
      type: "slot";
      id: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      width: number;
      construction?: boolean;
      dimPlace?: DimPlace;
    }
  | {
      type: "text";
      id: string;
      text: string;
      x: number;
      y: number;
      height: number;
      font?: string;
      style?: "regular" | "bold" | "italic" | "bolditalic";
      align?: "left" | "center" | "right";
      angle: number;
      pathRef?: string;
      positionOnPath?: number;
      boxWidth?: number;
      construction?: boolean;
    }
  // projected reference geometry: already plain numbers, so resolution passes it through
  | {
      type: "projected";
      id: string;
      source: ProjectedSource;
      curve: ProjectedCurve;
      stale?: true;
      construction?: boolean;
    };
