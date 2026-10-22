// The 9 constraint-tool click flows (horizontal/vertical/parallel/perpendicular/
// equal/tangent/coincident/concentric/symmetric): each adds a persistent geometric
// constraint that the solver maintains alongside every other constraint already on
// the sketch. Operates purely through the ConstraintHost accessor SketchMode
// provides, no state is copied, so this collaborator always sees SketchMode's
// live entities/constraints.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { pickEntity, PROJECTED_FIXED_MSG } from "./modify";
import { asRound, curveKind, dimRefPoints, lineOperand } from "./entityDims";
import { rectCorners } from "./region";
import type { SketchTool } from "./sketchMode";

export const CONSTRAINT_TOOLS = new Set<SketchTool>([
  "horizontal",
  "vertical",
  "parallel",
  "perpendicular",
  "equal",
  "tangent",
  "coincident",
  "concentric",
  "symmetric",
  "midpoint",
  "collinear",
  "fix",
]);

/** One operand of `ConstraintTools.applicable`: an entity or a rectangle side
 *  (`<rectId>~<k>`), with `p` a point
 *  index already resolved from a click position (dimRefPoints/resolvePoint)
 *  when the caller knows exactly which point was meant. Omitted when only the
 *  whole entity is known, e.g. a plain rail-selection with no click position. */
export interface ConstraintPick {
  id: string;
  p?: number;
}

/** `tool` names the constraint tool the option stands for, so a shortcut can
 *  apply it to the selection instead of arming the tool. */
export interface ConstraintOption {
  label: string;
  tool?: SketchTool;
  apply: () => void;
}

/** The slice of SketchMode these click flows read/write, live accessors, not copies. */
export interface ConstraintHost {
  /** current active sketch tool (drives which constraint flow fires) */
  tool(): SketchTool;
  /** live entity list, never copied */
  entities(): ResolvedEntity[];
  /** live constraint list, never copied; constraint flows push onto it */
  constraints(): SketchConstraint[];
  /** pick tolerance in plane units, scaled to current zoom */
  pickTol(): number;
  /** shared "first pick" slot for two-step line/entity flows, also used by
   *  SketchMode's own fillet tool (filletClick/modifyHover); reset to null on
   *  every setTool() */
  getFilletFirst(): number | null;
  setFilletFirst(idx: number | null): void;
  /** kick the solve pump after a constraint changes */
  requestSolve(): void;
  /** surface a user-facing warning (SketchMode routes it to the toast layer,
   *  kept an accessor so these flows stay DOM-free/unit-testable) */
  warn(msg: string): void;
}

export class ConstraintTools {
  constructor(private host: ConstraintHost) {}

  // coincident/symmetric/midpoint all start from an endpoint pick. We stash the
  // first pick (and, for symmetric, the second) on filletFirst-style state.
  private pendingEndpoint: { id: string; idx: number } | null = null;
  private pendingEndpoint2: { id: string; idx: number } | null = null;
  private firstOperand: Operand | null = null;

  /** whether an endpoint-based flow (coincident/symmetric/midpoint) is mid-pick */
  hasPending(): boolean {
    return this.pendingEndpoint != null || this.pendingEndpoint2 != null;
  }
  /** abandon any in-progress endpoint pick (tool switch, Escape, session end) */
  resetPending() {
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
    this.firstOperand = null;
  }

  /** add a persistent geometric constraint and re-solve (the solver maintains
   *  all constraints together, not just the one you applied). */
  click(p: THREE.Vector2) {
    const t = this.host.tool();
    // point-based constraints pick the nearest endpoint, not an entity body
    if (t === "coincident" || t === "symmetric" || t === "midpoint") {
      return this.pointConstraintClick(p);
    }
    if (t === "fix") return this.fixClick(p);
    if (t === "tangent") return this.tangentClick(p);
    if (t === "equal") return this.equalClick(p);
    if (t === "concentric") return this.concentricClick(p);

    // line-based constraints (horizontal/vertical/parallel/perpendicular/collinear)
    const op = this.operandAt(p);
    if (!op || op.kind !== "line") return;
    if (t === "horizontal" || t === "vertical") {
      // constraining the projected line ITSELF is meaningless, it's fixed;
      // a rectangle's sides already are
      if (op.ent?.type !== "line") {
        if (op.ent?.type === "projected") this.host.warn(PROJECTED_FIXED_MSG);
        return;
      }
      if (t === "horizontal") this.addConstraint({ type: "horizontal", line: op.id });
      else this.addConstraint({ type: "vertical", line: op.id });
    } else {
      const pair = this.secondOperand(op);
      if (!pair) return;
      const [a, b] = pair;
      if (t === "parallel") this.addConstraint({ type: "parallel", l1: a.id, l2: b.id });
      else if (t === "perpendicular") this.addConstraint({ type: "perpendicular", l1: a.id, l2: b.id });
      else if (t === "collinear") this.addConstraint({ type: "collinear", l1: a.id, l2: b.id });
    }
  }

  /** The curve under p as a constraint operand. A rectangle answers with its
   *  nearest side as a line operand (`<rectId>~<k>`, see entityDims.lineOperand). */
  private operandAt(p: THREE.Vector2): Operand | null {
    const entities = this.host.entities();
    const idx = pickEntity(entities, p, this.host.pickTol());
    const ent = idx >= 0 ? entities[idx] : undefined;
    if (!ent) return null;
    if (ent.type === "rectangle") {
      const k = nearestRectSide(ent, p);
      return { idx, id: `${ent.id}~${k}`, kind: "line" };
    }
    const kind = curveKind(ent);
    return kind ? { idx, id: ent.id, kind, ent } : null;
  }

  /** Two-pick flows: arms `op` as the first pick and returns null, or pairs it
   *  with the armed one. The filletFirst slot keeps the first pick highlighted
   *  and is the source of truth for whether one is armed (the host clears it). */
  private secondOperand(op: Operand): [Operand, Operand] | null {
    const armedIdx = this.host.getFilletFirst();
    const first = this.firstOperand;
    const armed = armedIdx != null && first && this.host.entities()[armedIdx]?.id === baseId(first.id) ? first : null;
    if (!armed) {
      this.firstOperand = op;
      this.host.setFilletFirst(op.idx);
      return null;
    }
    this.firstOperand = null;
    this.host.setFilletFirst(null);
    if (armed.id === op.id) return null;
    return [armed, op];
  }

  /** nearest addressable point (line/arc endpoint, a circle/arc centre, a
   *  rectangle corner, a bspline pole, a point entity, or a projected anchor)
   *  to p. Shares dimRefPoints with fixClick/pickDimTarget so every
   *  point-picking flow in the app agrees on what counts as "a point" and how
   *  it's indexed (public: SketchMode's constraint-menu also resolves a click
   *  to a specific point through here, see sketchMode.ts's constraintOptions). */
  resolvePoint(p: THREE.Vector2): { id: string; idx: number } | null {
    const tol = this.host.pickTol();
    let best: { id: string; idx: number } | null = null;
    let bestD = tol * tol;
    for (const e of this.host.entities()) {
      for (const r of dimRefPoints(e)) {
        const dx = r.pos.x - p.x,
          dy = r.pos.y - p.y,
          d = dx * dx + dy * dy;
        if (d <= bestD) {
          bestD = d;
          best = { id: e.id, idx: r.p };
        }
      }
    }
    return best;
  }

  private pointConstraintClick(p: THREE.Vector2) {
    const t = this.host.tool();
    if (t === "midpoint") {
      // pick a point/endpoint, then a line
      if (!this.pendingEndpoint) {
        const ep = this.resolvePoint(p);
        if (ep) this.pendingEndpoint = ep;
        return;
      }
      const op = this.operandAt(p);
      const ep = this.pendingEndpoint;
      this.pendingEndpoint = null;
      if (op?.kind === "line" && baseId(op.id) !== ep.id)
        this.addConstraint({ type: "midpoint", e: ep.id, p: ep.idx, line: op.id });
      return;
    }
    if (t === "coincident") {
      // a point, then a point (coincident) or a curve body (point on curve)
      const ep = this.resolvePoint(p);
      if (!this.pendingEndpoint) {
        if (ep) this.pendingEndpoint = ep;
        return;
      }
      const a = this.pendingEndpoint;
      this.pendingEndpoint = null;
      if (ep && ep.id !== a.id) {
        this.addConstraint({ type: "coincident", e1: a.id, p1: a.idx, e2: ep.id, p2: ep.idx });
        return;
      }
      const op = ep ? null : this.operandAt(p);
      if (op && baseId(op.id) !== a.id) this.addConstraint({ type: "pointOnCurve", e: a.id, p: a.idx, curve: op.id });
      return;
    }
    // symmetric: pick endpoint A, endpoint B, then the axis line
    if (!this.pendingEndpoint) {
      const ep = this.resolvePoint(p);
      if (ep) this.pendingEndpoint = ep;
      return;
    }
    if (!this.pendingEndpoint2) {
      const ep = this.resolvePoint(p);
      if (ep && ep.id !== this.pendingEndpoint.id) this.pendingEndpoint2 = ep;
      return;
    }
    const op = this.operandAt(p);
    const a = this.pendingEndpoint,
      b = this.pendingEndpoint2;
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
    if (op?.kind === "line")
      this.addConstraint({ type: "symmetric", e1: a.id, p1: a.idx, e2: b.id, p2: b.idx, line: op.id });
  }

  /** tangent between two curves: line/circle/arc, in any mix except line+line.
   *  Emits the general `tangent2`; the compiler picks the right planegcs variant. */
  private tangentClick(p: THREE.Vector2) {
    const op = this.operandAt(p);
    if (!op) return;
    const pair = this.secondOperand(op);
    if (!pair) return;
    const [first, e] = pair;
    if (first.kind === "line" && e.kind === "line") return this.host.warn(LINE_TANGENT_MSG);
    this.addConstraint({ type: "tangent2", a: first.id, b: e.id });
  }

  /** equal: two lines share length, or two circles/arcs share radius. */
  private equalClick(p: THREE.Vector2) {
    const op = this.operandAt(p);
    if (!op) return;
    const pair = this.secondOperand(op);
    if (!pair) return;
    const [first, e] = pair;
    if (first.kind === "line" && e.kind === "line") {
      this.addConstraint({ type: "equal", l1: first.id, l2: e.id });
    } else if (first.kind !== "line" && e.kind !== "line") {
      this.addConstraint({ type: "equalRadius", a: first.id, b: e.id });
    }
  }

  private concentricClick(p: THREE.Vector2) {
    const op = this.operandAt(p);
    if (!op || op.kind === "line") return; // circles and arcs both carry a center
    const pair = this.secondOperand(op);
    if (pair) this.addConstraint({ type: "concentric", c1: pair[0].id, c2: pair[1].id });
  }

  /** fix/lock: pin the nearest addressable point of any entity. Reuses
   *  dimRefPoints (line/arc endpoints, arc/circle centers, rect corners, spline
   *  ends) so the `p`-index convention lives in exactly one place. */
  private fixClick(p: THREE.Vector2) {
    const tol = this.host.pickTol();
    let best: { id: string; p: number } | null = null;
    let bestD = tol * tol;
    for (const e of this.host.entities()) {
      if (e.type === "projected") continue; // already fixed, fixing it is meaningless
      for (const r of dimRefPoints(e)) {
        const dx = r.pos.x - p.x,
          dy = r.pos.y - p.y,
          d = dx * dx + dy * dy;
        if (d <= bestD) {
          bestD = d;
          best = { id: e.id, p: r.p };
        }
      }
    }
    if (best) return this.addConstraint({ type: "fix", e: best.id, p: best.p });
    // no addressable point, explain a click on projected geometry (skipped
    // above: it is already fixed) instead of silently doing nothing
    const entities = this.host.entities();
    const idx = pickEntity(entities, p, tol);
    if (entities[idx]?.type === "projected") this.host.warn(PROJECTED_FIXED_MSG);
  }

  /** The constraints that make sense for the picks, mirroring each click flow's
   *  own eligibility check, so a selection-driven menu (the rail's Constrain
   *  popup, the right-click menu, a shortcut, see sketchMode.ts's
   *  constraintOptions) never offers something the matching tool would refuse.
   *  Three or more picks of one kind offer a chain: every pick related to the
   *  first, in one undo step.
   *
   *  A multi-point entity (rectangle corners, a line/arc's two endpoints)
   *  without a resolved `p` is never a point operand: guessing which point the
   *  user meant would produce a silently wrong constraint, worse than not
   *  offering one. */
  applicable(picks: ConstraintPick[]): ConstraintOption[] {
    const byId = new Map(this.host.entities().map((e) => [e.id, e]));
    const ops: PickOp[] = [];
    for (const pk of picks) {
      const op = pickOp(byId, pk);
      if (!op || ops.some((o) => o.id === op.id)) return [];
      ops.push(op);
    }
    const out: ConstraintOption[] = [];
    const add = (label: string, tool: SketchTool | undefined, cs: SketchConstraint[]) => {
      if (cs.length) out.push({ label, ...(tool ? { tool } : {}), apply: () => this.addConstraints(cs) });
    };
    if (ops.length === 1) {
      this.singleOptions(ops[0]!, add);
      return out;
    }
    if (ops.length < 2) return out;

    const [first, ...rest] = ops as [PickOp, ...PickOp[]];
    const all = (f: (o: PickOp) => boolean) => ops.every(f);
    const chain = (make: (a: PickOp, b: PickOp) => SketchConstraint) => rest.map((o) => make(first, o));
    const isLine = (o: PickOp) => o.kind === "line";
    const isRnd = (o: PickOp) => o.kind === "circle" || o.kind === "arc";
    const hasPt = (o: PickOp) => o.point !== null;

    if (all((o) => o.ent?.type === "line")) {
      add(
        "Horizontal",
        "horizontal",
        ops.map((o) => ({ type: "horizontal", line: o.id })),
      );
      add(
        "Vertical",
        "vertical",
        ops.map((o) => ({ type: "vertical", line: o.id })),
      );
    }
    if (all(isLine)) {
      add(
        "Parallel",
        "parallel",
        chain((a, b) => ({ type: "parallel", l1: a.id, l2: b.id })),
      );
      if (ops.length === 2)
        add(
          "Perpendicular",
          "perpendicular",
          chain((a, b) => ({ type: "perpendicular", l1: a.id, l2: b.id })),
        );
      add(
        "Equal",
        "equal",
        chain((a, b) => ({ type: "equal", l1: a.id, l2: b.id })),
      );
      add(
        "Collinear",
        "collinear",
        chain((a, b) => ({ type: "collinear", l1: a.id, l2: b.id })),
      );
    } else if (all(isRnd)) {
      add(
        "Concentric",
        "concentric",
        chain((a, b) => ({ type: "concentric", c1: a.id, c2: b.id })),
      );
      add(
        "Equal",
        "equal",
        chain((a, b) => ({ type: "equalRadius", a: a.id, b: b.id })),
      );
      if (ops.length === 2)
        add(
          "Tangent",
          "tangent",
          chain((a, b) => ({ type: "tangent2", a: a.id, b: b.id })),
        );
    } else if (ops.length === 2 && all((o) => o.kind !== undefined)) {
      // line and round: tangentClick refuses only line+line, routed above
      add(
        "Tangent",
        "tangent",
        chain((a, b) => ({ type: "tangent2", a: a.id, b: b.id })),
      );
    }

    // a point with a curve, either way round. A curve picked whole is preferred
    // over Coincident so I on a point and a circle puts the point on the rim, not
    // on the centre; a curve picked by a clicked end or centre is a point, so
    // Coincident comes first for it
    const curveOptions = (clicked: boolean) => {
      if (ops.length !== 2) return;
      for (const [pt, cv] of [
        [first, rest[0]!],
        [rest[0]!, first],
      ] as const) {
        if (cv.explicit !== clicked) continue;
        if (pt.point === null || !cv.kind || baseId(cv.id) === pt.id) continue;
        const p = pt.point;
        const centre = isRnd(pt) && p === centreIndex(pt.ent);
        // two rounds picked whole read as curves, a centre on the other's rim
        // needs the centre itself clicked
        if (centre && !pt.explicit && cv.kind !== "line") continue;
        add(centre ? (cv.kind === "line" ? "Centre on line" : "Centre on curve") : "On curve", "coincident", [
          { type: "pointOnCurve", e: pt.id, p, curve: cv.id },
        ]);
        if (cv.kind === "line")
          add(centre ? "Centre at midpoint" : "Midpoint", "midpoint", [{ type: "midpoint", e: pt.id, p, line: cv.id }]);
      }
    };
    curveOptions(false);

    if (all(hasPt)) {
      // concentric already says "same centre"; a redundant Coincident on round
      // centres would just confuse the relations list
      if (!all(isRnd)) {
        add(
          "Coincident",
          "coincident",
          chain((a, b) => ({ type: "coincident", e1: a.id, p1: a.point!, e2: b.id, p2: b.point! })),
        );
      }
      curveOptions(true);
      add(
        "Align horizontally",
        "horizontal",
        chain((a, b) => ({ type: "horizontalPoints", e1: a.id, p1: a.point!, e2: b.id, p2: b.point! })),
      );
      add(
        "Align vertically",
        "vertical",
        chain((a, b) => ({ type: "verticalPoints", e1: a.id, p1: a.point!, e2: b.id, p2: b.point! })),
      );
    }

    if (ops.length === 3) {
      // two points mirrored across an axis line, the axis being the one pick that is no point
      const axis = ops.filter((o) => isLine(o) && !hasPt(o));
      const pts = ops.filter(hasPt);
      const [pa, pb] = pts;
      if (axis.length === 1 && pa && pb && pa.point !== null && pb.point !== null) {
        add("Symmetric", "symmetric", [
          { type: "symmetric", e1: pa.id, p1: pa.point, e2: pb.id, p2: pb.point, line: axis[0]!.id },
        ]);
      }
    }
    return out;
  }

  private singleOptions(
    op: PickOp,
    add: (label: string, tool: SketchTool | undefined, cs: SketchConstraint[]) => void,
  ) {
    const e = op.ent;
    if (!e) return; // a lone rectangle side, its direction is already held
    if (e.type === "line") {
      add("Horizontal", "horizontal", [{ type: "horizontal", line: e.id }]);
      add("Vertical", "vertical", [{ type: "vertical", line: e.id }]);
    }
    // already fixed, fixing it is meaningless (mirrors fixClick's skip)
    if (e.type === "projected") return;
    if (e.type === "circle" || e.type === "arc") {
      add("Fix centre", "fix", [{ type: "fix", e: e.id, p: centreIndex(e) }]);
      if (e.type === "arc") {
        add("Fix start", undefined, [{ type: "fix", e: e.id, p: 0 }]);
        add("Fix end", undefined, [{ type: "fix", e: e.id, p: 1 }]);
      }
      const r = asRound(e)?.r;
      const sized = this.host
        .constraints()
        .some((c) => (c.type === "radius" && c.e === e.id) || (c.type === "diameter" && c.circle === e.id));
      if (r !== undefined && !sized)
        add("Radius", undefined, [{ type: "radius", e: e.id, value: Math.round(r * 1e6) / 1e6 }]);
      return;
    }
    if (op.point !== null) add("Fix", "fix", [{ type: "fix", e: e.id, p: op.point }]);
  }

  private addConstraint(c: SketchConstraint) {
    this.addConstraints([c]);
  }

  private addConstraints(cs: SketchConstraint[]) {
    this.host.constraints().push(...cs);
    this.host.requestSolve();
  }
}

export const LINE_TANGENT_MSG = "Two lines cannot be tangent, use Collinear or Parallel instead";

interface Operand {
  idx: number;
  id: string;
  kind: "line" | "circle" | "arc";
  ent?: ResolvedEntity;
}

/** One pick of `applicable`, decoded: `id` may be a rectangle side, `point` is
 *  the point index it stands for when that is unambiguous. */
interface PickOp {
  id: string;
  kind: "line" | "circle" | "arc" | undefined;
  ent?: ResolvedEntity;
  point: number | null;
  explicit: boolean;
}

function pickOp(byId: Map<string, ResolvedEntity>, pk: ConstraintPick): PickOp | null {
  if (pk.id.includes("~"))
    return lineOperand(byId, pk.id) ? { id: pk.id, kind: "line", point: null, explicit: false } : null;
  const e = byId.get(pk.id);
  if (!e) return null;
  const pts = dimRefPoints(e);
  const point = pk.p !== undefined ? pk.p : pts.length === 1 ? pts[0]!.p : null;
  return { id: e.id, kind: curveKind(e), ent: e, point, explicit: pk.p !== undefined };
}

const baseId = (id: string) => id.split("~")[0] ?? id;

const centreIndex = (e: ResolvedEntity | undefined) => (e?.type === "arc" ? 2 : 0);

export function nearestRectSide(e: Extract<ResolvedEntity, { type: "rectangle" }>, p: THREE.Vector2): number {
  const c = rectCorners(e.x, e.y, e.width, e.height, e.angle);
  let best = 0,
    bestD = Infinity;
  for (let k = 0; k < 4; k++) {
    const a = c[k]!,
      b = c[(k + 1) % 4]!;
    const ab = b.clone().sub(a);
    const l2 = ab.lengthSq();
    const t = l2 > 0 ? Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / l2)) : 0;
    const d = p.distanceTo(a.clone().addScaledVector(ab, t));
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}
