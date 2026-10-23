// 2D constraint solver bridge over planegcs (FreeCAD's PlaneGCS, WASM).

import { init_planegcs_module, GcsWrapper, SolveStatus } from "@salusoft89/planegcs";
import wasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";

export type PointId = string;
export interface SPoint {
  id: PointId;
  x: number;
  y: number;
  fixed?: boolean;
}
export interface SLine {
  id: string;
  p1: PointId;
  p2: PointId;
}
export interface SCircle {
  id: string;
  center: PointId;
  radius: number;
}
// arc_rules keeps the endpoints on the circle at the sweep angles, so lines can share them.
export interface SArc {
  id: string;
  center: PointId;
  start: PointId;
  end: PointId;
  radius: number;
  startAngle: number;
  endAngle: number;
}

export type SConstraint =
  | { id: string; type: "coincident"; a: PointId; b: PointId }
  | { id: string; type: "horizontal"; line: string }
  | { id: string; type: "vertical"; line: string }
  | { id: string; type: "parallel"; l1: string; l2: string }
  | { id: string; type: "perpendicular"; l1: string; l2: string }
  | { id: string; type: "equal"; l1: string; l2: string }
  | { id: string; type: "distance"; a: PointId; b: PointId; value: number }
  // b.x - a.x (axis x) or b.y - a.y (axis y) = value, signed
  | { id: string; type: "axisDistance"; a: PointId; b: PointId; axis: "x" | "y"; value: number }
  | { id: string; type: "p2lDistance"; p: PointId; line: string; value: number }
  | { id: string; type: "diameter"; circle: string; value: number }
  | { id: string; type: "tangentLC"; line: string; circle: string }
  | { id: string; type: "tangentLA"; line: string; arc: string }
  | { id: string; type: "tangentCC"; c1: string; c2: string }
  | { id: string; type: "tangentCA"; circle: string; arc: string }
  | { id: string; type: "tangentAA"; a1: string; a2: string }
  | { id: string; type: "angleLL"; l1: string; l2: string; value: number } // radians
  | { id: string; type: "circleRadius"; circle: string; value: number }
  | { id: string; type: "arcRadius"; arc: string; value: number }
  | { id: string; type: "equalRadiusCC"; c1: string; c2: string }
  | { id: string; type: "equalRadiusCA"; circle: string; arc: string }
  | { id: string; type: "equalRadiusAA"; a1: string; a2: string }
  | { id: string; type: "pointOnLine"; p: PointId; line: string }
  | { id: string; type: "pointOnPerpBisector"; p: PointId; line: string }
  | { id: string; type: "pointOnCircle"; p: PointId; circle: string }
  | { id: string; type: "pointOnArc"; p: PointId; arc: string }
  | { id: string; type: "symmetric"; a: PointId; b: PointId; line: string }
  // round1, round2 and round name a circle OR arc (planegcs's Arc derives from Circle). Not all are signed, see
  // entityDims.rimGap, and sketchSolve's guard re-checks the branch each was created in.
  | { id: string; type: "rimGap"; round1: string; round2: string; value: number }
  | { id: string; type: "rimLine"; round: string; line: string; value: number }
  | { id: string; type: "rimPoint"; p: PointId; round: string; value: number }
  // outer.radius - inner.radius = value, SIGNED. c2cdistance's nested branch is unsigned and converges to an inverted
  // annulus, so it must not be used for wall thickness.
  | { id: string; type: "radiusDifference"; inner: string; outer: string; value: number };

export interface SolveInput {
  points: SPoint[];
  lines: SLine[];
  circles: SCircle[];
  arcs?: SArc[];
  constraints: SConstraint[];
  drag?: { point: PointId; x: number; y: number };
}
export interface SolveResult {
  points: Record<PointId, { x: number; y: number }>;
  circles: Record<string, number>; // solved radii
  arcs: Record<string, { radius: number }>; // solved radii (angles recomputed from points)
  dof: number;
  ok: boolean;
  conflicts: string[]; // constraints that can't be satisfied (sketch is inconsistent)
  redundant: string[]; // constraints removable without changing DOF (over-defined)
  partiallyRedundant: string[]; // constraints that partially duplicate others
}

interface Solver {
  w: GcsWrapper;
  heap: Uint8Array;
  pristine: Uint8Array;
}

// planegcs orders unknowns by heap address and DogLeg's answer on an under-constrained sketch follows that
// order, so every solve restores the heap `new GcsSystem` left (a fixed 16 MB that never grows, 0.4 ms).
function resetHeap(s: Solver): void {
  s.heap.set(s.pristine);
  s.heap.fill(0, s.pristine.length);
}

let wrapperPromise: Promise<Solver> | null = null;
function getWrapper(): Promise<Solver> {
  if (!wrapperPromise) {
    wrapperPromise = (async () => {
      const mod = await init_planegcs_module({ locateFile: () => wasmUrl });
      const w = new GcsWrapper(new mod.GcsSystem());
      const heap: Uint8Array = mod.HEAPU8;
      const words = new Uint32Array(heap.buffer, heap.byteOffset, heap.length >> 2);
      let top = words.length;
      while (top > 0 && words[top - 1] === 0) top--;
      return { w, heap, pristine: heap.slice(0, top * 4) };
    })().catch((err) => {
      // A cached rejection would fail every later solve, and a failed fetch or instantiate at startup
      // can be transient, so the next solve retries.
      wrapperPromise = null;
      throw new SolverUnavailable(err);
    });
  }
  return wrapperPromise;
}

/** planegcs's embind glue builds invokers with the `Function` constructor, which 'wasm-unsafe-eval' does not allow,
 *  so this means our own CSP regressed, not the user's machine. tauri dev and vitest have no CSP, e2e/solver_csp.cjs
 *  catches it. Keep the message blaming the build. */
export class SolverUnavailable extends Error {
  constructor(readonly cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      /content security policy|unsafe-eval|code generation/i.test(detail)
        ? "The 2D constraint solver could not start: this build's security policy blocks the " +
            "code it needs to initialise. That is a bug in FundaCAD, not a problem with your " +
            "system, so updating your webview or graphics drivers will not help. Sketching " +
            "still works, but without constraints, dimensions or point dragging."
        : `The 2D constraint solver could not start: ${detail}`,
    );
    this.name = "SolverUnavailable";
  }
}

/** Resolves to false instead of rejecting, a warm-up failure must not reach the global unhandledrejection net. The
 *  real error is raised at the point of use. */
export async function initSolver(): Promise<boolean> {
  try {
    await getWrapper();
    return true;
  } catch {
    return false;
  }
}

export async function solveSketch(input: SolveInput): Promise<SolveResult> {
  const solver = await getWrapper();
  resetHeap(solver);
  const w = solver.w;
  w.clear_data();

  const prims: any[] = [];
  for (const p of input.points) prims.push({ id: p.id, type: "point", x: p.x, y: p.y, fixed: !!p.fixed });
  for (const l of input.lines) prims.push({ id: l.id, type: "line", p1_id: l.p1, p2_id: l.p2 });
  for (const c of input.circles) prims.push({ id: c.id, type: "circle", c_id: c.center, radius: c.radius });
  const fixedIds = new Set(input.points.filter((p) => p.fixed).map((p) => p.id));
  for (const a of input.arcs ?? []) {
    prims.push({
      id: a.id,
      type: "arc",
      c_id: a.center,
      start_id: a.start,
      end_id: a.end,
      radius: a.radius,
      start_angle: a.startAngle,
      end_angle: a.endAngle,
    });
    // With all three points fixed, arc_rules puts 4 equations on the arc's 3 own params, which planegcs
    // reports as redundant, and as a conflict once user geometry is tied to the arc, so pin the params instead.
    if (fixedIds.has(a.center) && fixedIds.has(a.start) && fixedIds.has(a.end)) {
      const pins = { start_angle: a.startAngle, end_angle: a.endAngle, radius: a.radius };
      for (const [prop, value] of Object.entries(pins))
        prims.push({
          id: `${a.id}~${prop}`,
          type: "difference",
          param1: 0,
          param2: { o_id: a.id, prop },
          difference: value,
        });
    } else prims.push({ id: `${a.id}_rules`, type: "arc_rules", a_id: a.id });
  }
  for (const c of input.constraints) prims.push(toGcsConstraint(c));
  if (input.drag) {
    prims.push({ id: "__drag", type: "point", x: input.drag.x, y: input.drag.y, fixed: true });
    prims.push({ id: "__dragc", type: "p2p_coincident", p1_id: input.drag.point, p2_id: "__drag", temporary: true });
  }

  w.push_primitives_and_params(prims);
  const status = w.solve();
  w.apply_solution();

  const points: Record<string, { x: number; y: number }> = {};
  for (const p of input.points) {
    const sp = w.sketch_index.get_sketch_point(p.id);
    if (sp) points[p.id] = { x: sp.x, y: sp.y };
  }
  const circles: Record<string, number> = {};
  for (const c of input.circles) {
    const sc = w.sketch_index.get_sketch_circle(c.id);
    if (sc) circles[c.id] = sc.radius;
  }
  const arcs: Record<string, { radius: number }> = {};
  for (const a of input.arcs ?? []) {
    const sa = w.sketch_index.get_sketch_arc(a.id);
    if (sa) arcs[a.id] = { radius: sa.radius };
  }
  return {
    points,
    circles,
    arcs,
    dof: w.gcs.dof(),
    ok: status === SolveStatus.Success,
    conflicts: safeList(() => w.get_gcs_conflicting_constraints?.()),
    redundant: safeList(() => w.get_gcs_redundant_constraints?.()),
    partiallyRedundant: safeList(() => w.get_gcs_partially_redundant_constraints?.()),
  };
}

/** Read a planegcs diagnostic list, tolerating a missing method / throw. */
function safeList(get: () => string[] | undefined): string[] {
  try {
    return get() ?? [];
  } catch {
    return [];
  }
}

function toGcsConstraint(c: SConstraint): any {
  switch (c.type) {
    case "coincident":
      return { id: c.id, type: "p2p_coincident", p1_id: c.a, p2_id: c.b };
    case "horizontal":
      return { id: c.id, type: "horizontal_l", l_id: c.line };
    case "vertical":
      return { id: c.id, type: "vertical_l", l_id: c.line };
    case "parallel":
      return { id: c.id, type: "parallel", l1_id: c.l1, l2_id: c.l2 };
    case "perpendicular":
      return { id: c.id, type: "perpendicular_ll", l1_id: c.l1, l2_id: c.l2 };
    case "equal":
      return { id: c.id, type: "equal_length", l1_id: c.l1, l2_id: c.l2 };
    case "distance":
      return { id: c.id, type: "p2p_distance", p1_id: c.a, p2_id: c.b, distance: c.value };
    case "axisDistance":
      return {
        id: c.id,
        type: "difference",
        param1: { o_id: c.a, prop: c.axis },
        param2: { o_id: c.b, prop: c.axis },
        difference: c.value,
      };
    case "p2lDistance":
      return { id: c.id, type: "p2l_distance", p_id: c.p, l_id: c.line, distance: c.value };
    case "diameter":
      return { id: c.id, type: "circle_diameter", c_id: c.circle, diameter: c.value };
    case "tangentLC":
      return { id: c.id, type: "tangent_lc", l_id: c.line, c_id: c.circle };
    case "tangentLA":
      return { id: c.id, type: "tangent_la", l_id: c.line, a_id: c.arc };
    case "tangentCC":
      return { id: c.id, type: "tangent_cc", c1_id: c.c1, c2_id: c.c2 };
    case "tangentCA":
      return { id: c.id, type: "tangent_ca", c_id: c.circle, a_id: c.arc };
    case "tangentAA":
      return { id: c.id, type: "tangent_aa", a1_id: c.a1, a2_id: c.a2 };
    case "angleLL":
      return { id: c.id, type: "l2l_angle_ll", l1_id: c.l1, l2_id: c.l2, angle: c.value };
    case "circleRadius":
      return { id: c.id, type: "circle_radius", c_id: c.circle, radius: c.value };
    case "arcRadius":
      return { id: c.id, type: "arc_radius", a_id: c.arc, radius: c.value };
    case "equalRadiusCC":
      return { id: c.id, type: "equal_radius_cc", c1_id: c.c1, c2_id: c.c2 };
    case "equalRadiusCA":
      return { id: c.id, type: "equal_radius_ca", c1_id: c.circle, a2_id: c.arc };
    case "equalRadiusAA":
      return { id: c.id, type: "equal_radius_aa", a1_id: c.a1, a2_id: c.a2 };
    case "pointOnLine":
      return { id: c.id, type: "point_on_line_pl", p_id: c.p, l_id: c.line };
    case "pointOnCircle":
      return { id: c.id, type: "point_on_circle", p_id: c.p, c_id: c.circle };
    case "pointOnArc":
      return { id: c.id, type: "point_on_arc", p_id: c.p, a_id: c.arc };
    case "pointOnPerpBisector":
      return { id: c.id, type: "point_on_perp_bisector_pl", p_id: c.p, l_id: c.line };
    case "symmetric":
      return { id: c.id, type: "p2p_symmetric_ppl", p1_id: c.a, p2_id: c.b, l_id: c.line };
    case "rimGap":
      return { id: c.id, type: "c2cdistance", c1_id: c.round1, c2_id: c.round2, dist: c.value };
    case "rimLine":
      return { id: c.id, type: "c2ldistance", c_id: c.round, l_id: c.line, dist: c.value };
    case "rimPoint":
      return { id: c.id, type: "p2cdistance", p_id: c.p, c_id: c.round, distance: c.value };
    case "radiusDifference":
      // param2 - param1 = difference (planegcs semantics)
      return {
        id: c.id,
        type: "difference",
        param1: { o_id: c.inner, prop: "radius" },
        param2: { o_id: c.outer, prop: "radius" },
        difference: c.value,
      };
  }
}
