// Compiles the active sketch and its constraints into the solver model and writes the solved positions back.
// Endpoints at one position merge into one solver point (coincKey), centers and interior points never merge.
// A rectangle expands into 4 corners and 4 implicit edges so it stays rectangular yet one entity in the document.

import type { ResolvedEntity } from "./snap";
import { solveSketch, type SConstraint, type SPoint, type SLine, type SCircle, type SArc } from "./solver";
import { circumcenter } from "./arc";
import { rectCorners, rectFromThreePoints } from "./region";
import { asRound, lineOperand, refPoint, rimNesting, RIM_EPS, type Round } from "./entityDims";
import type { SketchConstraint } from "../types";
import { isDriven, projEndSamples } from "../types";
import { poleOfRef } from "./bspline";
import { solverAngleDeg } from "./angleWedge";

export interface SolvePass {
  entities: ResolvedEntity[];
  dof: number;
  ok: boolean;
  conflicts: string[]; // inconsistent constraints (sketch can't solve)
  overDefined: string[]; // redundant + partially-redundant (removable / over-defining)
  /** The grabbed point is fixed (projected vs a user `fix`). The caller must not advance its drag anchor on a refusal,
   *  or the nearest-point search re-runs from the cursor and grabs an unrelated free point. */
  dragRefused?: "projected" | "fix";
}

const TAU = Math.PI * 2;
const ccwDelta = (from: number, to: number) => (((to - from) % TAU) + TAU) % TAU;

/** Two points merge iff their keys match (0.001mm buckets). Anything asking whether endpoints are attached must use
 *  this key, or it drifts from the solver. */
export const coincKey = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;

/** Composite constraints append a non-numeric suffix (`${constraintKey(i)}a`), so the leading integer decodes back to
 *  the index. The single source of the id to index convention. */
export const constraintKey = (i: number) => `k${i}`;

/** null for implicit ids (`<id>~h0`, `<id>~r`, the drag pin). Any id with `~` is implicit by contract, reporting must
 *  never blame a user constraint for one. */
export function constraintIndexOf(id: string): number | null {
  if (id.includes("~")) return null;
  const m = /^k(\d+)/.exec(id);
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

/** After a typed dimension: lines drawn horizontal or vertical keep that direction where allowed and `anchor` stays
 *  put, so lengthening one side of a drawn rectangle moves only the far side. The held pass only places geometry, a
 *  plain pass then reports dof and diagnostics against the user's constraints. */
export async function solveKeepingAxes(
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
  anchor?: { x: number; y: number },
): Promise<SolvePass> {
  const tries = anchor ? [{ holdAxes: true, pin: anchor }, { holdAxes: true }] : [{ holdAxes: true }];
  for (const opts of tries) {
    const held = await compileAndSolve(entities, constraints, undefined, opts);
    if (!held.ok || held.conflicts.length) continue;
    const settled = await compileAndSolve(held.entities, constraints);
    if (settled.ok && !settled.conflicts.length) return settled;
  }
  return compileAndSolve(entities, constraints);
}

const AXIS_TOL = 1e-6;

export async function compileAndSolve(
  entities: ResolvedEntity[],
  constraints: SketchConstraint[],
  drag?: { fromX: number; fromY: number; toX: number; toY: number },
  opts?: { holdAxes?: boolean; pin?: { x: number; y: number } },
): Promise<SolvePass> {
  const points: SPoint[] = [];
  const pointByKey = new Map<string, string>();
  const key = coincKey;
  // Mergeable points coincide by position, unique points (centers, interior spline points) never merge.
  const getPoint = (x: number, y: number, mergeable = true): string => {
    if (mergeable) {
      const existing = pointByKey.get(key(x, y));
      if (existing) return existing;
    }
    const id = `P${points.length}`;
    if (mergeable) pointByKey.set(key(x, y), id);
    points.push({ id, x, y });
    return id;
  };

  const lines: SLine[] = [];
  const circles: SCircle[] = [];
  const arcs: SArc[] = [];
  const cons: SConstraint[] = [];
  const ends = new Map<string, [string, string]>(); // line entity id -> [p1, p2]
  const centers = new Map<string, string>(); // circle entity id -> center point
  // arc entity id -> our endpoints (entity x1y1/x2y2), solved center, sweep start
  const arcMap = new Map<string, { ourS: string; ourE: string; center: string; startIsOurS: boolean }>();
  const splineMap = new Map<string, string[]>(); // spline entity id -> fit-point ids
  const poleMap = new Map<string, string[]>(); // bspline entity id -> pole ids
  const rectMap = new Map<string, string[]>(); // rectangle entity id -> 4 corner points
  const pointMap = new Map<string, string>(); // point entity id -> its solver point
  const fixedPts = new Set<string>(); // solver point ids pinned by a `fix` constraint / projected geometry
  const projPts = new Set<string>(); // the subset of fixedPts pinned by PROJECTED geometry (drag-refusal messaging)
  const pinProjected = (...ids: string[]) => {
    for (const id of ids) {
      fixedPts.add(id);
      projPts.add(id);
    }
  };
  // Projected circle and arc ids: their radius is pinned too, so they are fully rigid (the inert check needs it).
  const projRounds = new Set<string>();

  // Shared by user and projected arcs, null when degenerate.
  const compileArc = (
    id: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    mx: number,
    my: number,
  ): { ourS: string; ourE: string; center: string } | null => {
    const cc = circumcenter({ x: x1, y: y1 }, { x: x2, y: y2 }, { x: mx, y: my });
    if (!cc) return null; // collinear/degenerate, leave untouched
    const radius = Math.hypot(x1 - cc.x, y1 - cc.y);
    const ourS = getPoint(x1, y1);
    const ourE = getPoint(x2, y2);
    const center = getPoint(cc.x, cc.y, false); // arc center is not an endpoint
    const aS = Math.atan2(y1 - cc.y, x1 - cc.x);
    const aE = Math.atan2(y2 - cc.y, x2 - cc.x);
    const aT = Math.atan2(my - cc.y, mx - cc.x);
    // orient the arc CCW so its sweep passes through the through-point
    const ccwThroughFromStart = ccwDelta(aS, aT) <= ccwDelta(aS, aE);
    const start = ccwThroughFromStart ? ourS : ourE;
    const startA = ccwThroughFromStart ? aS : aE;
    const end = ccwThroughFromStart ? ourE : ourS;
    const endA = ccwThroughFromStart ? aE : aS;
    arcs.push({
      id,
      center,
      start,
      end,
      radius,
      startAngle: startA,
      endAngle: startA + ccwDelta(startA, endA),
    });
    arcMap.set(id, { ourS, ourE, center, startIsOurS: ccwThroughFromStart });
    return { ourS, ourE, center };
  };

  for (const e of entities) {
    if (e.type === "line") {
      const p1 = getPoint(e.x1, e.y1);
      const p2 = getPoint(e.x2, e.y2);
      lines.push({ id: e.id, p1, p2 });
      ends.set(e.id, [p1, p2]);
      if (opts?.holdAxes && p1 !== p2) {
        if (Math.abs(e.y2 - e.y1) <= AXIS_TOL) cons.push({ id: `${e.id}~holdH`, type: "horizontal", line: e.id });
        else if (Math.abs(e.x2 - e.x1) <= AXIS_TOL) cons.push({ id: `${e.id}~holdV`, type: "vertical", line: e.id });
      }
    } else if (e.type === "circle") {
      const c = getPoint(e.x, e.y, false); // center is not an endpoint
      circles.push({ id: e.id, center: c, radius: e.radius });
      centers.set(e.id, c);
    } else if (e.type === "rectangle") {
      const corner = rectCorners(e.x, e.y, e.width, e.height, e.angle); // CCW: bl, br, tr, tl
      const cp = corner.map((p) => getPoint(p.x, p.y, true));
      for (let k = 0; k < 4; k++) {
        const a = cp[k],
          b = cp[(k + 1) % 4];
        if (a === undefined || b === undefined) continue;
        lines.push({ id: `${e.id}~${k}`, p1: a, p2: b });
        // Registering rect edges ("<rectId>~<k>") makes isLine() and ends.get() accept them as line operands. Side effect:
        // endpointPoint() resolves `rect~k` too, so a coincident on a rect edge would resolve to its corners.
        ends.set(`${e.id}~${k}`, [a, b]);
      }
      if (e.angle) {
        // A rotated rectangle is pinned rigid like a polygon (RIGID_ENTITY_NUM_FIELDS). The axis rules would straighten it,
        // and parallel sides plus a square corner leave the angle free (dimensioning a 37.5 degree rectangle spun it to 33.8).
        // Pinned corners stay solver points, so snaps work and a fighting dimension reports over-constrained.
        for (const p of cp) if (p !== undefined) fixedPts.add(p);
      } else {
        cons.push({ id: `${e.id}~h0`, type: "horizontal", line: `${e.id}~0` }); // bottom
        cons.push({ id: `${e.id}~h2`, type: "horizontal", line: `${e.id}~2` }); // top
        cons.push({ id: `${e.id}~v1`, type: "vertical", line: `${e.id}~1` }); // right
        cons.push({ id: `${e.id}~v3`, type: "vertical", line: `${e.id}~3` }); // left
      }
      rectMap.set(e.id, cp);
    } else if (e.type === "arc") {
      compileArc(e.id, e.x1, e.y1, e.x2, e.y2, e.mx, e.my);
    } else if (e.type === "spline") {
      // endpoints are mergeable (chain with lines); interior points are unique
      const last = e.points.length - 1;
      splineMap.set(
        e.id,
        e.points.map((p, k) => getPoint(p.x, p.y, k === 0 || k === last)),
      );
    } else if (e.type === "bspline") {
      // An open curve's end poles are on the curve and chain like endpoints, the others keep their own identity.
      const last = e.poles.length - 1;
      poleMap.set(
        e.id,
        e.poles.map((p, k) => getPoint(p.x, p.y, !e.closed && (k === 0 || k === last))),
      );
    } else if (e.type === "point") {
      // a sketch point is mergeable so it can snap onto / coincide with geometry
      pointMap.set(e.id, getPoint(e.x, e.y, true));
    } else if (e.type === "projected") {
      // Projected geometry compiles as pinned primitives so user constraints can attach. Endpoints are mergeable on
      // purpose, a coincident user endpoint fuses with the fixed point and is anchored. Write-back skips projected entities.
      const cv = e.curve;
      if (cv.kind === "line") {
        const p1 = getPoint(cv.x1, cv.y1);
        const p2 = getPoint(cv.x2, cv.y2);
        lines.push({ id: e.id, p1, p2 });
        ends.set(e.id, [p1, p2]);
        pinProjected(p1, p2);
      } else if (cv.kind === "circle") {
        const c = getPoint(cv.x, cv.y, false); // center is not an endpoint
        circles.push({ id: e.id, center: c, radius: cv.r });
        centers.set(e.id, c);
        pinProjected(c);
        projRounds.add(e.id);
        // A planegcs circle radius is free, so pin it with an implicit `~` id that reporting never blames on the user.
        cons.push({ id: `${e.id}~r`, type: "circleRadius", circle: e.id, value: cv.r });
      } else if (cv.kind === "arc") {
        // arc_rules holds radius and sweep once all three points are fixed, so no radius pin is needed.
        const m = compileArc(e.id, cv.x1, cv.y1, cv.x2, cv.y2, cv.mx, cv.my);
        if (m) {
          pinProjected(m.ourS, m.ourE, m.center);
          projRounds.add(e.id);
        }
      } else {
        // Only the first and last poly samples are real model points (one for a closed poly), registered like spline ends.
        // Interior samples never enter the solver.
        const sampleIds = projEndSamples(cv).map(([x, y]) => getPoint(x, y));
        if (sampleIds.length) {
          splineMap.set(e.id, sampleIds);
          pinProjected(...sampleIds);
        }
      }
    }
  }

  const isLine = (id: string) => ends.has(id);
  // 0 = start, 1 = end, arc center 2. Mirrors dimPoint's rect, center and arc-center checks, otherwise coincident,
  // symmetric and midpoint on those targets silently compile away.
  const endpointPoint = (entId: string, idx: number): string | undefined => {
    const rc = rectMap.get(entId);
    if (rc) return rc[idx];
    if (centers.has(entId)) return centers.get(entId);
    const ln = ends.get(entId);
    if (ln) return idx === 0 ? ln[0] : ln[1];
    const ar = arcMap.get(entId);
    if (ar) return idx === 2 ? ar.center : idx === 0 ? ar.ourS : ar.ourE;
    const pt = pointMap.get(entId);
    if (pt) return pt;
    const sp = splineMap.get(entId);
    if (sp) return idx === 0 ? sp[0] : sp[sp.length - 1];
    const poles = poleMap.get(entId);
    if (poles) return poles[poleOfRef(idx, poles.length)];
    return undefined;
  };
  const centerPoint = (entId: string): string | undefined => centers.get(entId) ?? arcMap.get(entId)?.center;
  // Rectangle corners by index, circle centers regardless of index, arc center at index 2, else endpoints.
  const dimPoint = (entId: string, idx: number): string | undefined => {
    const rc = rectMap.get(entId);
    if (rc) return rc[idx];
    if (centers.has(entId)) return centers.get(entId);
    if (idx === 2) return arcMap.get(entId)?.center;
    return endpointPoint(entId, idx);
  };
  const isCircle = (id: string) => centers.has(id);
  // planegcs's Arc derives from Circle, so the rim constraints accept either.
  const isRound = (id: string) => centers.has(id) || arcMap.has(id);
  const kindOf = (id: string): "line" | "circle" | "arc" | undefined =>
    ends.has(id) ? "line" : centers.has(id) ? "circle" : arcMap.has(id) ? "arc" : undefined;
  constraints.forEach((c, i) => {
    const id = constraintKey(i); // user constraint ids never collide with `~` implicit ones
    if (isDriven(c)) return; // reference dim: measured only, never constrains
    if (c.type === "horizontal") {
      if (isLine(c.line)) cons.push({ id, type: "horizontal", line: c.line });
    } else if (c.type === "vertical") {
      if (isLine(c.line)) cons.push({ id, type: "vertical", line: c.line });
    } else if (c.type === "parallel") {
      if (isLine(c.l1) && isLine(c.l2)) cons.push({ id, type: "parallel", l1: c.l1, l2: c.l2 });
    } else if (c.type === "perpendicular") {
      if (isLine(c.l1) && isLine(c.l2)) cons.push({ id, type: "perpendicular", l1: c.l1, l2: c.l2 });
    } else if (c.type === "equal") {
      if (isLine(c.l1) && isLine(c.l2)) cons.push({ id, type: "equal", l1: c.l1, l2: c.l2 });
    } else if (c.type === "distance") {
      const e = ends.get(c.line);
      if (e) cons.push({ id, type: "distance", a: e[0], b: e[1], value: c.value });
    } else if (c.type === "p2pDistance") {
      const a = dimPoint(c.e1, c.p1),
        b = dimPoint(c.e2, c.p2);
      if (a && b && a !== b) cons.push({ id, type: "distance", a, b, value: c.value });
    } else if (c.type === "hDistance" || c.type === "vDistance") {
      const a = dimPoint(c.e1, c.p1),
        b = dimPoint(c.e2, c.p2);
      if (a && b && a !== b)
        cons.push({ id, type: "axisDistance", a, b, axis: c.type === "hDistance" ? "x" : "y", value: c.value });
    } else if (c.type === "p2lDistance") {
      const p = dimPoint(c.e, c.p);
      if (p && isLine(c.line)) cons.push({ id, type: "p2lDistance", p, line: c.line, value: c.value });
    } else if (c.type === "diameter") {
      if (centers.has(c.circle)) cons.push({ id, type: "diameter", circle: c.circle, value: c.value });
      // An arc can carry a diameter dim (Radius/Diameter override), planegcs has no arc_diameter so halve it.
      else if (arcMap.has(c.circle)) cons.push({ id, type: "arcRadius", arc: c.circle, value: c.value / 2 });
    }
    // Rim (edge-to-edge) dims: one planegcs constraint each.
    else if (c.type === "radialGap") {
      if (isRound(c.inner) && isRound(c.outer) && c.inner !== c.outer) {
        cons.push({ id, type: "radiusDifference", inner: c.inner, outer: c.outer, value: c.value });
      }
    } else if (c.type === "c2cDistance") {
      if (isRound(c.c1) && isRound(c.c2) && c.c1 !== c.c2) {
        cons.push({ id, type: "rimGap", round1: c.c1, round2: c.c2, value: c.value });
      }
    } else if (c.type === "c2lDistance") {
      if (isRound(c.circle) && isLine(c.line)) {
        cons.push({ id, type: "rimLine", round: c.circle, line: c.line, value: c.value });
      }
    } else if (c.type === "p2cDistance") {
      const p = dimPoint(c.e, c.p);
      if (p && isRound(c.circle)) cons.push({ id, type: "rimPoint", p, round: c.circle, value: c.value });
    } else if (c.type === "tangent") {
      if (isLine(c.line) && isCircle(c.circle)) cons.push({ id, type: "tangentLC", line: c.line, circle: c.circle });
    }
    // A join already fused into one solver point by the position merge would be
    // p2p_coincident(P, P), which planegcs reports as redundant (over-defined).
    else if (c.type === "coincident") {
      const a = endpointPoint(c.e1, c.p1),
        b = endpointPoint(c.e2, c.p2);
      if (a && b && a !== b) cons.push({ id, type: "coincident", a, b });
    } else if (c.type === "concentric") {
      const a = centerPoint(c.c1),
        b = centerPoint(c.c2);
      if (a && b && a !== b) cons.push({ id, type: "coincident", a, b });
    } else if (c.type === "horizontalPoints" || c.type === "verticalPoints") {
      const a = endpointPoint(c.e1, c.p1),
        b = endpointPoint(c.e2, c.p2);
      const axis = c.type === "horizontalPoints" ? "y" : "x";
      if (a && b && a !== b) cons.push({ id, type: "axisDistance", a, b, axis, value: 0 });
    } else if (c.type === "midpoint") {
      const p = endpointPoint(c.e, c.p);
      if (p && isLine(c.line)) {
        cons.push({ id: `${id}a`, type: "pointOnLine", p, line: c.line });
        cons.push({ id: `${id}b`, type: "pointOnPerpBisector", p, line: c.line });
      }
    } else if (c.type === "pointOnCurve") {
      const p = endpointPoint(c.e, c.p),
        k = kindOf(c.curve);
      if (p && k === "line") cons.push({ id, type: "pointOnLine", p, line: c.curve });
      else if (p && k === "circle") cons.push({ id, type: "pointOnCircle", p, circle: c.curve });
      else if (p && k === "arc") cons.push({ id, type: "pointOnArc", p, arc: c.curve });
    } else if (c.type === "symmetric") {
      const a = endpointPoint(c.e1, c.p1),
        b = endpointPoint(c.e2, c.p2);
      if (a && b && isLine(c.line)) cons.push({ id, type: "symmetric", a, b, line: c.line });
    } else if (c.type === "angle") {
      if (isLine(c.l1) && isLine(c.l2))
        cons.push({
          id,
          type: "angleLL",
          l1: c.l1,
          l2: c.l2,
          value: (solverAngleDeg(c.value, c.rays) * Math.PI) / 180,
        });
    } else if (c.type === "radius") {
      if (centers.has(c.e)) cons.push({ id, type: "circleRadius", circle: c.e, value: c.value });
      else if (arcMap.has(c.e)) cons.push({ id, type: "arcRadius", arc: c.e, value: c.value });
    } else if (c.type === "fix") {
      const p = dimPoint(c.e, c.p);
      if (p) fixedPts.add(p);
    } else if (c.type === "collinear") {
      const e1 = ends.get(c.l1),
        e2 = ends.get(c.l2);
      if (isLine(c.l1) && isLine(c.l2) && e1 && e2) {
        // Lines sharing a point need only their far end on l1, a parallel on top of it is redundant.
        const far = e2.filter((p) => !e1.includes(p));
        if (far.length === 2) cons.push({ id: `${id}p`, type: "parallel", l1: c.l1, l2: c.l2 });
        if (far[0] !== undefined) cons.push({ id: `${id}o`, type: "pointOnLine", p: far[0], line: c.l1 });
      }
    } else if (c.type === "equalRadius") {
      const ka = kindOf(c.a),
        kb = kindOf(c.b);
      if (ka === "circle" && kb === "circle") cons.push({ id, type: "equalRadiusCC", c1: c.a, c2: c.b });
      else if (ka === "arc" && kb === "arc") cons.push({ id, type: "equalRadiusAA", a1: c.a, a2: c.b });
      else if (ka === "circle" && kb === "arc") cons.push({ id, type: "equalRadiusCA", circle: c.a, arc: c.b });
      else if (ka === "arc" && kb === "circle") cons.push({ id, type: "equalRadiusCA", circle: c.b, arc: c.a });
    } else if (c.type === "tangent2") {
      const ka = kindOf(c.a),
        kb = kindOf(c.b);
      if (ka === "line" && kb === "circle") cons.push({ id, type: "tangentLC", line: c.a, circle: c.b });
      else if (ka === "circle" && kb === "line") cons.push({ id, type: "tangentLC", line: c.b, circle: c.a });
      else if (ka === "line" && kb === "arc") cons.push({ id, type: "tangentLA", line: c.a, arc: c.b });
      else if (ka === "arc" && kb === "line") cons.push({ id, type: "tangentLA", line: c.b, arc: c.a });
      else if (ka === "circle" && kb === "circle") cons.push({ id, type: "tangentCC", c1: c.a, c2: c.b });
      else if (ka === "arc" && kb === "arc") cons.push({ id, type: "tangentAA", a1: c.a, a2: c.b });
      else if (ka === "circle" && kb === "arc") cons.push({ id, type: "tangentCA", circle: c.a, arc: c.b });
      else if (ka === "arc" && kb === "circle") cons.push({ id, type: "tangentCA", circle: c.b, arc: c.a });
    } else if (c.type === "offset") {
      // Sub-ids put a LETTER before the pair number so constraintKey decodes them back to this constraint ("k12p3" is 12),
      // a digit-first suffix would decode wrong ("k1" + "0" is 10).
      const mag = Math.abs(c.value); // p2l_distance is unsigned; rimBranch holds the side
      c.pairs.forEach((pr, n) => {
        // A rect-edge operand is already direction-locked by the rectangle's implicit rules, so one distance and no
        // parallel: 4 edges by 1 equation is exactly its 4 DOF.
        const rectEdge = pr.src.includes("~") && pr.cpy.includes("~");
        if (isLine(pr.src) && isLine(pr.cpy)) {
          const e = ends.get(pr.cpy);
          if (!e) return;
          if (rectEdge) {
            cons.push({ id: `${id}a${n}`, type: "p2lDistance", p: e[0], line: pr.src, value: mag });
            return;
          }
          cons.push({ id: `${id}p${n}`, type: "parallel", l1: pr.src, l2: pr.cpy });
          // One endpoint distance: with the copy parallel a second p2l_distance is redundant (11 redundants on a 4-line square).
          cons.push({ id: `${id}a${n}`, type: "p2lDistance", p: e[0], line: pr.src, value: mag });
        } else if (isRound(pr.src) && isRound(pr.cpy) && pr.src !== pr.cpy) {
          const a = centerPoint(pr.src),
            b = centerPoint(pr.cpy);
          if (a && b) cons.push({ id: `${id}c${n}`, type: "coincident", a, b });
          // cpy.r − src.r, SIGNED, so the copy cannot cross its source as a p2l_distance can. offsetChain sets flip per arc.
          cons.push({
            id: `${id}r${n}`,
            type: "radiusDifference",
            inner: pr.src,
            outer: pr.cpy,
            value: pr.flip ? -c.value : c.value,
          });
        }
      });
    }
  });

  const pinned = opts?.pin ? pointByKey.get(key(opts.pin.x, opts.pin.y)) : undefined;
  if (pinned) fixedPts.add(pinned);
  for (const p of points) if (fixedPts.has(p.id)) p.fixed = true;

  let dragInput: { point: string; x: number; y: number } | undefined;
  let dragRefused: "projected" | "fix" | undefined;
  if (drag) {
    // Pin whichever solver point sits nearest the grab position. Coincident
    // endpoints have merged into one point, so a grabbed corner moves as a unit.
    let best: SPoint | null = null;
    let bestD = Infinity;
    for (const p of points) {
      const dx = p.x - drag.fromX,
        dy = p.y - drag.fromY;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    // A fixed nearest point cannot move: refuse the drag rather than fight the fixed flag, and report it so the caller
    // keeps its anchor.
    if (best && !best.fixed) dragInput = { point: best.id, x: drag.toX, y: drag.toY };
    else if (best) dragRefused = projPts.has(best.id) ? "projected" : "fix";
  }

  const r = await solveSketch({
    points,
    lines,
    circles,
    arcs,
    constraints: cons,
    ...(dragInput ? { drag: dragInput } : {}),
  });

  // planegcs never sees a constraint whose operands are all fixed and accepts it even when violated, so classify these
  // inert ones here: satisfied is redundant (amber), violated is a conflict (red).
  const conflicts = [...r.conflicts];
  const redundant = [...r.redundant];
  // No fixed points means nothing can be inert, so ordinary sketches and every drag frame skip this pass.
  if (fixedPts.size) {
    // mm (radians for angles). Above the engine's 6-decimal rounding floor (~1.4e-6) and matching its 1e-4 mm change
    // tolerance, so a satisfied inert dim grades amber, not red.
    const INERT_TOL = 1e-4;
    const pos = new Map(points.map((p) => [p.id, p])); // fixed ⇒ input == solved
    const lineEnds = new Map(lines.map((l) => [l.id, l]));
    const radiusOf = new Map<string, number>([
      ...circles.map((c) => [c.id, c.radius] as const),
      ...arcs.map((a) => [a.id, a.radius] as const),
    ]);
    const centerOf = new Map<string, string>([
      ...circles.map((c) => [c.id, c.center] as const),
      ...arcs.map((a) => [a.id, a.center] as const),
    ]);
    const fx = (id: string) => fixedPts.has(id);
    const fxLine = (id: string) => {
      const l = lineEnds.get(id);
      return !!l && fx(l.p1) && fx(l.p2);
    };
    const fxRound = (id: string) => projRounds.has(id); // center fixed AND radius pinned
    const roundAt = (id: string) => radiusOf.get(id)!;
    const P = (id: string) => pos.get(id)!;
    const dist = (aId: string, bId: string) => {
      const a = P(aId),
        b = P(bId);
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const lineDir = (id: string) => {
      const l = lineEnds.get(id)!;
      const a = P(l.p1),
        b = P(l.p2);
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    };
    const lineLen = (id: string) => {
      const l = lineEnds.get(id)!;
      return dist(l.p1, l.p2);
    };
    const perpDist = (pId: string, lId: string) => {
      const l = lineEnds.get(lId)!;
      const a = P(l.p1),
        b = P(l.p2),
        q = P(pId);
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return Math.abs((q.x - a.x) * (b.y - a.y) - (q.y - a.y) * (b.x - a.x)) / len;
    };
    const tangentRes = (aId: string, bId: string) => {
      // two rounds: outer or inner tangency
      const d = dist(centerOf.get(aId)!, centerOf.get(bId)!);
      const r1 = radiusOf.get(aId)!,
        r2 = radiusOf.get(bId)!;
      return Math.min(Math.abs(d - (r1 + r2)), Math.abs(d - Math.abs(r1 - r2)));
    };
    // residual of an inert constraint, or null when any operand is still free
    const inertResidual = (c: SConstraint): number | null => {
      switch (c.type) {
        // Self-coincident (both ends merged into one point) is absorbed by the merge, not over-defining.
        case "coincident":
          return c.a !== c.b && fx(c.a) && fx(c.b) ? dist(c.a, c.b) : null;
        case "horizontal": {
          if (!fxLine(c.line)) return null;
          const l = lineEnds.get(c.line)!;
          return Math.abs(P(l.p1).y - P(l.p2).y);
        }
        case "vertical": {
          if (!fxLine(c.line)) return null;
          const l = lineEnds.get(c.line)!;
          return Math.abs(P(l.p1).x - P(l.p2).x);
        }
        case "parallel": {
          if (!fxLine(c.l1) || !fxLine(c.l2)) return null;
          const d1 = lineDir(c.l1),
            d2 = lineDir(c.l2);
          return Math.abs(d1.x * d2.y - d1.y * d2.x);
        }
        case "perpendicular": {
          if (!fxLine(c.l1) || !fxLine(c.l2)) return null;
          const d1 = lineDir(c.l1),
            d2 = lineDir(c.l2);
          return Math.abs(d1.x * d2.x + d1.y * d2.y);
        }
        case "equal":
          return fxLine(c.l1) && fxLine(c.l2) ? Math.abs(lineLen(c.l1) - lineLen(c.l2)) : null;
        case "distance":
          return fx(c.a) && fx(c.b) ? Math.abs(dist(c.a, c.b) - c.value) : null;
        case "axisDistance":
          return fx(c.a) && fx(c.b) ? Math.abs(P(c.b)[c.axis] - P(c.a)[c.axis] - c.value) : null;
        case "p2lDistance":
          return fx(c.p) && fxLine(c.line) ? Math.abs(perpDist(c.p, c.line) - c.value) : null;
        case "diameter":
          return fxRound(c.circle) ? Math.abs(2 * radiusOf.get(c.circle)! - c.value) : null;
        case "circleRadius":
          return fxRound(c.circle) ? Math.abs(radiusOf.get(c.circle)! - c.value) : null;
        case "arcRadius":
          return fxRound(c.arc) ? Math.abs(radiusOf.get(c.arc)! - c.value) : null;
        case "tangentLC":
          return fxLine(c.line) && fxRound(c.circle)
            ? Math.abs(perpDist(centerOf.get(c.circle)!, c.line) - radiusOf.get(c.circle)!)
            : null;
        case "tangentLA":
          return fxLine(c.line) && fxRound(c.arc)
            ? Math.abs(perpDist(centerOf.get(c.arc)!, c.line) - radiusOf.get(c.arc)!)
            : null;
        case "tangentCC":
          return fxRound(c.c1) && fxRound(c.c2) ? tangentRes(c.c1, c.c2) : null;
        case "tangentCA":
          return fxRound(c.circle) && fxRound(c.arc) ? tangentRes(c.circle, c.arc) : null;
        case "tangentAA":
          return fxRound(c.a1) && fxRound(c.a2) ? tangentRes(c.a1, c.a2) : null;
        case "angleLL": {
          if (!fxLine(c.l1) || !fxLine(c.l2)) return null;
          const d1 = lineDir(c.l1),
            d2 = lineDir(c.l2);
          const actual = Math.atan2(d1.x * d2.y - d1.y * d2.x, d1.x * d2.x + d1.y * d2.y);
          const w = ((((actual - c.value) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
          return Math.abs(w);
        }
        case "equalRadiusCC":
          return fxRound(c.c1) && fxRound(c.c2) ? Math.abs(radiusOf.get(c.c1)! - radiusOf.get(c.c2)!) : null;
        case "equalRadiusCA":
          return fxRound(c.circle) && fxRound(c.arc) ? Math.abs(radiusOf.get(c.circle)! - radiusOf.get(c.arc)!) : null;
        case "equalRadiusAA":
          return fxRound(c.a1) && fxRound(c.a2) ? Math.abs(radiusOf.get(c.a1)! - radiusOf.get(c.a2)!) : null;
        case "pointOnLine":
          return fx(c.p) && fxLine(c.line) ? perpDist(c.p, c.line) : null;
        case "pointOnCircle":
          return fx(c.p) && fxRound(c.circle)
            ? Math.abs(dist(c.p, centerOf.get(c.circle)!) - radiusOf.get(c.circle)!)
            : null;
        case "pointOnArc":
          return fx(c.p) && fxRound(c.arc) ? Math.abs(dist(c.p, centerOf.get(c.arc)!) - radiusOf.get(c.arc)!) : null;
        case "pointOnPerpBisector": {
          if (!fx(c.p) || !fxLine(c.line)) return null;
          const l = lineEnds.get(c.line)!;
          return Math.abs(dist(c.p, l.p1) - dist(c.p, l.p2));
        }
        case "symmetric": {
          if (!fx(c.a) || !fx(c.b) || !fxLine(c.line)) return null;
          const l = lineEnds.get(c.line)!;
          const A = P(l.p1),
            d = lineDir(c.line),
            a = P(c.a),
            b = P(c.b);
          const t = (a.x - A.x) * d.x + (a.y - A.y) * d.y;
          const mx = 2 * (A.x + t * d.x) - a.x,
            my = 2 * (A.y + t * d.y) - a.y;
          return Math.hypot(mx - b.x, my - b.y);
        }
        // rim dims: the same measures entityDims defines, over the pinned params
        case "rimGap": {
          if (!fxRound(c.round1) || !fxRound(c.round2)) return null;
          const g1 = roundAt(c.round1),
            g2 = roundAt(c.round2);
          const d = dist(centerOf.get(c.round1)!, centerOf.get(c.round2)!);
          const rd = Math.abs(g1 - g2);
          return Math.abs((d < rd ? rd - d : d - g1 - g2) - c.value);
        }
        case "rimLine": {
          if (!fxRound(c.round) || !fxLine(c.line)) return null;
          return Math.abs(perpDist(centerOf.get(c.round)!, c.line) - roundAt(c.round) - c.value);
        }
        case "rimPoint": {
          if (!fx(c.p) || !fxRound(c.round)) return null;
          return Math.abs(Math.abs(dist(c.p, centerOf.get(c.round)!) - roundAt(c.round)) - c.value);
        }
        case "radiusDifference":
          return fxRound(c.inner) && fxRound(c.outer) ? Math.abs(roundAt(c.outer) - roundAt(c.inner) - c.value) : null;
      }
    };
    for (const c of cons) {
      if (constraintIndexOf(c.id) === null) continue; // implicit pins are exempt
      const res = inertResidual(c);
      if (res === null) continue;
      const list = res <= INERT_TOL ? redundant : conflicts;
      if (!list.includes(c.id)) list.push(c.id);
    }
  }

  const out = entities.map((e): ResolvedEntity => {
    if (e.type === "line") {
      const [p1, p2] = ends.get(e.id)!;
      const a = r.points[p1],
        b = r.points[p2];
      return a && b ? { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y } : e;
    }
    if (e.type === "circle") {
      const c = r.points[centers.get(e.id)!];
      const rad = r.circles[e.id];
      return c ? { ...e, x: c.x, y: c.y, radius: rad ?? e.radius } : e;
    }
    if (e.type === "rectangle") {
      const cp = rectMap.get(e.id);
      const pts = cp?.map((id) => r.points[id]);
      if (!pts || pts.some((p) => !p)) return e;
      if (e.angle) {
        // Read the rectangle back from its solved corners, the tool's three-point recovery: the bounding box of a 10x4 at
        // 37.5 degrees is 10.4 x 9.3. Unmoved pinned corners are not re-derived (200 degrees became -160.00000000000003).
        const was = rectCorners(e.x, e.y, e.width, e.height, e.angle);
        if (pts.every((p, k) => p!.x === was[k]?.x && p!.y === was[k]?.y)) return e;
        const rec = rectFromThreePoints(pts[0]!, pts[1]!, pts[2]!);
        return rec ? { ...e, ...rec } : e; // degenerate solve: keep what we had
      }
      const xs = pts.map((p) => p!.x),
        ys = pts.map((p) => p!.y);
      const minX = Math.min(...xs),
        maxX = Math.max(...xs);
      const minY = Math.min(...ys),
        maxY = Math.max(...ys);
      return { ...e, x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY };
    }
    if (e.type === "arc") {
      const m = arcMap.get(e.id);
      if (!m) return e; // wasn't solved (degenerate)
      const s = r.points[m.ourS],
        en = r.points[m.ourE],
        c = r.points[m.center];
      if (!s || !en || !c) return e;
      // Through-point is the mid-sweep from solved endpoints and center, robust to the solver's angle normalisation.
      const rad = r.arcs[e.id]?.radius ?? Math.hypot(s.x - c.x, s.y - c.y);
      const [from, to] = m.startIsOurS ? [s, en] : [en, s];
      const aFrom = Math.atan2(from.y - c.y, from.x - c.x);
      const aTo = Math.atan2(to.y - c.y, to.x - c.x);
      const midA = aFrom + ccwDelta(aFrom, aTo) / 2;
      return {
        ...e,
        x1: s.x,
        y1: s.y,
        x2: en.x,
        y2: en.y,
        mx: c.x + Math.cos(midA) * rad,
        my: c.y + Math.sin(midA) * rad,
      };
    }
    if (e.type === "spline") {
      const ids = splineMap.get(e.id);
      if (!ids) return e;
      // ids is 1:1 with e.points, so `orig` is the fallback when the solver returned no position.
      return {
        ...e,
        points: e.points.map((orig, k) => {
          const id = ids[k];
          return (id !== undefined ? r.points[id] : undefined) ?? orig;
        }),
      };
    }
    if (e.type === "bspline") {
      const ids = poleMap.get(e.id);
      if (!ids) return e;
      return {
        ...e,
        poles: e.poles.map((orig, k) => {
          const id = ids[k];
          return (id !== undefined ? r.points[id] : undefined) ?? orig;
        }),
      };
    }
    if (e.type === "point") {
      const p = r.points[pointMap.get(e.id)!];
      return p ? { ...e, x: p.x, y: p.y } : e;
    }
    return e;
  });

  // planegcs reports success for a radius through zero or an inside-out rim distance (p2c, c2l and nested c2cdistance
  // are unsigned). Blame the constraints and return the pre-solve geometry, so the caller paints a red chip instead
  // of a broken part.
  const badGeom = new Set<string>();
  for (const [eid, rad] of Object.entries(r.circles)) {
    if (!(rad > RIM_EPS) || !Number.isFinite(rad)) badGeom.add(eid);
  }
  for (const [eid, a] of Object.entries(r.arcs)) {
    if (!(a.radius > RIM_EPS) || !Number.isFinite(a.radius)) badGeom.add(eid);
  }
  const guardIds = new Set<string>();
  if (badGeom.size) {
    for (const c of cons) {
      if (constraintIndexOf(c.id) === null) continue; // implicit pins aren't the user's fault
      if (roundRefs(c).some((id) => badGeom.has(id))) guardIds.add(c.id);
    }
  }
  // branch invariants: a rim dim must still describe the SAME configuration it
  // was created in (see entityDims.rimGap for why the branches can't be trusted)
  if (constraints.some(isRimDim)) {
    const beforeById = new Map(entities.map((e) => [e.id, e]));
    const afterById = new Map(out.map((e) => [e.id, e]));
    constraints.forEach((c, i) => {
      if (isDriven(c) || !isRimDim(c)) return;
      const cls = rimBranch(c, beforeById);
      if (cls !== null && !sameBranch(cls, rimBranch(c, afterById))) guardIds.add(constraintKey(i));
    });
  }
  if (guardIds.size || badGeom.size) {
    for (const id of guardIds) if (!conflicts.includes(id)) conflicts.push(id);
    return {
      entities,
      dof: r.dof,
      ok: false,
      conflicts,
      overDefined: [...redundant, ...r.partiallyRedundant],
      ...(dragRefused ? { dragRefused } : {}),
    };
  }

  return {
    entities: out,
    dof: r.dof,
    ok: r.ok && conflicts.length === r.conflicts.length,
    conflicts,
    overDefined: [...redundant, ...r.partiallyRedundant],
    ...(dragRefused ? { dragRefused } : {}),
  };
}

/** The blame list when one of them solves to a non-positive radius. */
function roundRefs(c: SConstraint): string[] {
  switch (c.type) {
    case "diameter":
    case "circleRadius":
      return [c.circle];
    case "arcRadius":
      return [c.arc];
    case "rimGap":
      return [c.round1, c.round2];
    case "rimLine":
    case "rimPoint":
      return [c.round];
    case "radiusDifference":
      return [c.inner, c.outer];
    case "tangentLC":
      return [c.circle];
    case "tangentLA":
      return [c.arc];
    case "tangentCC":
    case "equalRadiusCC":
      return [c.c1, c.c2];
    case "tangentCA":
    case "equalRadiusCA":
      return [c.circle, c.arc];
    case "tangentAA":
    case "equalRadiusAA":
      return [c.a1, c.a2];
    default:
      return [];
  }
}

/** `radialGap` is absent on purpose: `difference` is signed, so it cannot invert an annulus by itself. */
const isRimDim = (c: SketchConstraint): boolean =>
  c.type === "c2cDistance" || c.type === "p2cDistance" || c.type === "c2lDistance" || c.type === "offset";

/** null for non-rim dims or gone operands. Comparing it across a solve stops an annulus inverting, a point crossing a
 *  rim or a circle hopping sides of a line while the number stays satisfied. */
function rimBranch(c: SketchConstraint, byId: Map<string, ResolvedEntity>): string | null {
  const round = (id: string): Round | null => {
    const e = byId.get(id);
    return e ? asRound(e) : null;
  };
  if (c.type === "c2cDistance") {
    const a = round(c.c1),
      b = round(c.c2);
    return a && b ? `nest:${rimNesting(a, b)}` : null;
  }
  if (c.type === "p2cDistance") {
    const e = byId.get(c.e);
    const p = e ? refPoint(e, c.p) : null;
    const cc = round(c.circle);
    if (!p || !cc) return null;
    return `side:${Math.hypot(p.x - cc.x, p.y - cc.y) >= cc.r ? "out" : "in"}`;
  }
  if (c.type === "c2lDistance") {
    const cc = round(c.circle);
    const seg = lineOperand(byId, c.line);
    if (!cc || !seg) return null;
    const dx = seg.x2 - seg.x1,
      dy = seg.y2 - seg.y1;
    const dist = ((cc.x - seg.x1) * dy - (cc.y - seg.y1) * dx) / (Math.hypot(dx, dy) || 1);
    const side = Math.abs(dist) < RIM_EPS ? "on" : dist > 0 ? "+" : "-";
    return `side:${side}:${Math.abs(dist) >= cc.r ? "out" : "in"}`;
  }
  if (c.type === "offset") {
    // Only line pairs can flip, their p2l_distance is unsigned. Round pairs use the signed `difference` and contribute a
    // constant ".".
    const sides = c.pairs.map((pr) => {
      const s = lineOperand(byId, pr.src),
        t = lineOperand(byId, pr.cpy);
      if (!s || !t) return ".";
      const dx = s.x2 - s.x1,
        dy = s.y2 - s.y1;
      const mx = (t.x1 + t.x2) / 2,
        my = (t.y1 + t.y2) / 2;
      return (mx - s.x1) * dy - (my - s.y1) * dx >= 0 ? "+" : "-";
    });
    return sides.length ? `off:${sides.join("")}` : null;
  }
  return null;
}

// A centre on the line is on neither side, so it may leave it for either and still be the same configuration.
function sameBranch(before: string, after: string | null): boolean {
  const a = before.split(":"),
    b = after?.split(":") ?? [];
  return a.length === b.length && a.every((s, k) => s === b[k] || s === "on" || b[k] === "on");
}
