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
import { curveKind, dimRefPoints } from "./entityDims";
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

/** line/circle/arc are the tangency-capable curves (curveKind, see entityDims);
 *  circle/arc carry a radius+center. */
const isCurve = (e: ResolvedEntity) => curveKind(e) !== undefined;
const isRound = (e: ResolvedEntity) => { const k = curveKind(e); return k === "circle" || k === "arc"; };

/** One operand of `ConstraintTools.applicable`: an entity, with `p` a point
 *  index already resolved from a click position (dimRefPoints/resolvePoint)
 *  when the caller knows exactly which point was meant. Omitted when only the
 *  whole entity is known, e.g. a plain rail-selection with no click position. */
export interface ConstraintPick { id: string; p?: number }

export interface ConstraintOption { label: string; apply: () => void }

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

  /** whether an endpoint-based flow (coincident/symmetric/midpoint) is mid-pick */
  hasPending(): boolean {
    return this.pendingEndpoint != null || this.pendingEndpoint2 != null;
  }
  /** abandon any in-progress endpoint pick (tool switch, Escape, session end) */
  resetPending() {
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
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
    const entities = this.host.entities();
    const idx = pickEntity(entities, p, this.host.pickTol());
    const ent = idx >= 0 ? entities[idx] : undefined;
    if (!ent || curveKind(ent) !== "line") return;
    if (t === "horizontal" || t === "vertical") {
      // constraining the projected line ITSELF is meaningless, it's fixed
      if (ent.type !== "line") return this.host.warn(PROJECTED_FIXED_MSG);
      if (t === "horizontal") this.addConstraint({ type: "horizontal", line: ent.id });
      else this.addConstraint({ type: "vertical", line: ent.id });
    } else {
      const id = ent.id;
      // two-line constraints: first click stores, second applies
      if (this.host.getFilletFirst() == null) {
        this.host.setFilletFirst(idx);
        return;
      }
      const a = entities[this.host.getFilletFirst()!]?.id;
      this.host.setFilletFirst(null);
      if (!a || a === id) return;
      if (t === "parallel") this.addConstraint({ type: "parallel", l1: a, l2: id });
      else if (t === "perpendicular") this.addConstraint({ type: "perpendicular", l1: a, l2: id });
      else if (t === "collinear") this.addConstraint({ type: "collinear", l1: a, l2: id });
    }
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
        const dx = r.pos.x - p.x, dy = r.pos.y - p.y, d = dx * dx + dy * dy;
        if (d <= bestD) { bestD = d; best = { id: e.id, idx: r.p }; }
      }
    }
    return best;
  }

  private pointConstraintClick(p: THREE.Vector2) {
    const t = this.host.tool();
    const entities = this.host.entities();
    if (t === "midpoint") {
      // pick a point/endpoint, then a line
      if (!this.pendingEndpoint) {
        const ep = this.resolvePoint(p);
        if (ep) this.pendingEndpoint = ep;
        return;
      }
      const idx = pickEntity(entities, p, this.host.pickTol());
      const e = idx >= 0 ? entities[idx] : null;
      const ep = this.pendingEndpoint;
      this.pendingEndpoint = null;
      if (e && curveKind(e) === "line" && e.id !== ep.id) this.addConstraint({ type: "midpoint", e: ep.id, p: ep.idx, line: e.id });
      return;
    }
    if (t === "coincident") {
      const ep = this.resolvePoint(p);
      if (!ep) return;
      if (!this.pendingEndpoint) { this.pendingEndpoint = ep; return; }
      const a = this.pendingEndpoint;
      this.pendingEndpoint = null;
      if (a.id !== ep.id) this.addConstraint({ type: "coincident", e1: a.id, p1: a.idx, e2: ep.id, p2: ep.idx });
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
    // third click: the symmetry axis line
    const idx = pickEntity(entities, p, this.host.pickTol());
    const e = idx >= 0 ? entities[idx] : null;
    const a = this.pendingEndpoint, b = this.pendingEndpoint2;
    this.pendingEndpoint = null;
    this.pendingEndpoint2 = null;
    if (e && curveKind(e) === "line") this.addConstraint({ type: "symmetric", e1: a.id, p1: a.idx, e2: b.id, p2: b.idx, line: e.id });
  }

  /** Two-pick flow shared by tangent/equal/concentric: returns [first, second]
   *  once a second valid curve lands (both pass `ok`, distinct); null while
   *  arming the first pick or on an invalid pick. Uses the filletFirst slot. */
  private pickPair(p: THREE.Vector2, ok: (e: ResolvedEntity) => boolean): [ResolvedEntity, ResolvedEntity] | null {
    const entities = this.host.entities();
    const idx = pickEntity(entities, p, this.host.pickTol());
    const e = idx >= 0 ? entities[idx] : undefined;
    if (!e || !ok(e)) return null;
    if (this.host.getFilletFirst() == null) { this.host.setFilletFirst(idx); return null; }
    const first = entities[this.host.getFilletFirst()!];
    this.host.setFilletFirst(null);
    if (!first || first.id === e.id) return null;
    return [first, e];
  }

  /** tangent between two curves: line/circle/arc, in any mix except line+line.
   *  Emits the general `tangent2`; the compiler picks the right planegcs variant. */
  private tangentClick(p: THREE.Vector2) {
    const pair = this.pickPair(p, isCurve);
    if (!pair) return;
    const [first, e] = pair;
    if (curveKind(first) === "line" && curveKind(e) === "line") return; // two lines can't be tangent
    this.addConstraint({ type: "tangent2", a: first.id, b: e.id });
  }

  /** equal: two lines share length, or two circles/arcs share radius. */
  private equalClick(p: THREE.Vector2) {
    const pair = this.pickPair(p, isCurve);
    if (!pair) return;
    const [first, e] = pair;
    if (curveKind(first) === "line" && curveKind(e) === "line") {
      this.addConstraint({ type: "equal", l1: first.id, l2: e.id });
    } else if (isRound(first) && isRound(e)) {
      this.addConstraint({ type: "equalRadius", a: first.id, b: e.id });
    }
  }

  private concentricClick(p: THREE.Vector2) {
    const pair = this.pickPair(p, isRound); // circles and arcs both carry a center
    if (!pair) return;
    this.addConstraint({ type: "concentric", c1: pair[0].id, c2: pair[1].id });
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
        const dx = r.pos.x - p.x, dy = r.pos.y - p.y, d = dx * dx + dy * dy;
        if (d <= bestD) { bestD = d; best = { id: e.id, p: r.p }; }
      }
    }
    if (best) return this.addConstraint({ type: "fix", e: best.id, p: best.p });
    // no addressable point, explain a click on projected geometry (skipped
    // above: it is already fixed) instead of silently doing nothing
    const entities = this.host.entities();
    const idx = pickEntity(entities, p, tol);
    if (entities[idx]?.type === "projected") this.host.warn(PROJECTED_FIXED_MSG);
  }

  /** Which of the 12 supported constraint types make sense for 1-2 picks,
   *  mirroring each click flow's own eligibility check above exactly
   *  (pickPair/pointConstraintClick/click), so a selection-driven menu (the
   *  rail's Constrain popup, the right-click menu, see sketchMode.ts's
   *  constraintOptions) can never offer something the matching tool's own
   *  click would refuse.
   *
   *  A multi-point entity (rectangle corners, a line/arc's two endpoints)
   *  without a resolved `p` never offers Coincident/Fix: guessing which point
   *  the user meant would produce a silently wrong constraint, worse than not
   *  offering one. */
  applicable(picks: ConstraintPick[]): ConstraintOption[] {
    const byId = new Map(this.host.entities().map((e) => [e.id, e]));
    const out: ConstraintOption[] = [];
    const solePoint = (id: string, p?: number): number | null => {
      if (p !== undefined) return p;
      const e = byId.get(id);
      if (!e) return null;
      const pts = dimRefPoints(e);
      const only = pts.length === 1 ? pts[0] : undefined;
      return only ? only.p : null;
    };

    if (picks.length === 1) {
      const a = picks[0];
      const e = a && byId.get(a.id);
      if (!e) return out;
      if (e.type === "line") {
        out.push({ label: "Horizontal", apply: () => this.addConstraint({ type: "horizontal", line: e.id }) });
        out.push({ label: "Vertical", apply: () => this.addConstraint({ type: "vertical", line: e.id }) });
      }
      // already fixed, fixing it is meaningless (mirrors fixClick's skip)
      const p = e.type !== "projected" ? solePoint(e.id, a?.p) : null;
      if (p !== null) out.push({ label: "Fix", apply: () => this.addConstraint({ type: "fix", e: e.id, p }) });
      return out;
    }
    if (picks.length !== 2) return out;

    const [pa, pb] = picks;
    const ea = pa && byId.get(pa.id);
    const eb = pb && byId.get(pb.id);
    if (!ea || !eb || ea.id === eb.id) return out;
    const aLine = curveKind(ea) === "line", bLine = curveKind(eb) === "line";
    const aRound = isRound(ea), bRound = isRound(eb);

    if (aLine && bLine) {
      out.push({ label: "Parallel", apply: () => this.addConstraint({ type: "parallel", l1: ea.id, l2: eb.id }) });
      out.push({ label: "Perpendicular", apply: () => this.addConstraint({ type: "perpendicular", l1: ea.id, l2: eb.id }) });
      out.push({ label: "Equal", apply: () => this.addConstraint({ type: "equal", l1: ea.id, l2: eb.id }) });
      out.push({ label: "Collinear", apply: () => this.addConstraint({ type: "collinear", l1: ea.id, l2: eb.id }) });
    } else if (isCurve(ea) && isCurve(eb)) {
      if (aRound && bRound) {
        out.push({ label: "Concentric", apply: () => this.addConstraint({ type: "concentric", c1: ea.id, c2: eb.id }) });
        out.push({ label: "Equal", apply: () => this.addConstraint({ type: "equalRadius", a: ea.id, b: eb.id }) });
      }
      // tangentClick refuses only line+line, already routed above
      out.push({ label: "Tangent", apply: () => this.addConstraint({ type: "tangent2", a: ea.id, b: eb.id }) });
    }

    // concentric already says "same centre"; a redundant Coincident on two
    // round centres would just confuse the relations list
    if (!(aRound && bRound)) {
      const p1 = solePoint(ea.id, pa?.p), p2 = solePoint(eb.id, pb?.p);
      if (p1 !== null && p2 !== null) {
        out.push({ label: "Coincident", apply: () => this.addConstraint({ type: "coincident", e1: ea.id, p1, e2: eb.id, p2 }) });
      }
    }
    return out;
  }

  private addConstraint(c: SketchConstraint) {
    this.host.constraints().push(c);
    this.host.requestSolve();
  }
}
