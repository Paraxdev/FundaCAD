// Constraint glyphs: a small on-canvas badge per GEOMETRIC constraint, showing
// its type and letting the user see/delete relationships (Fusion's "Show
// Constraints"). Dimensional constraints (distance/diameter/p2p/p2l/radius/angle)
// are NOT glyphed here, they already render as editable dimension badges.

import * as THREE from "three";
import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { refPoint } from "./entityDims";

const V = (x: number, y: number) => new THREE.Vector2(x, y);

export interface ConstraintGlyph {
  cIndex: number; // index into the constraints array (delete target)
  icon: string; // icon name drawn in the badge
  pos: THREE.Vector2; // 2D sketch-plane position
}

/** The solver's diagnosis of a constraint, or null if clean. Conflict (can't be
 *  satisfied) takes precedence over over-defined (redundant/removable). This is
 *  the single source of that precedence, glyph and dimension badges both use it,
 *  so their red/amber can't drift apart. */
export type ConstraintDiagnosis = "conflict" | "over";
export function diagnosisOf(i: number, conflict: Set<number>, over: Set<number>): ConstraintDiagnosis | null {
  return conflict.has(i) ? "conflict" : over.has(i) ? "over" : null;
}

/** The name, icon and operands of a constraint, THE table, shared by the glyph
 *  badges and the list so a constraint cannot be called one thing on the canvas
 *  and another in the panel. Operand ids may be compound rectangle-edge ids
 *  (`<rectId>~<k>`); entityLabel decodes those. */
export function constraintFace(c: SketchConstraint): {
  icon: string;
  name: string;
  operands: string[];
} {
  switch (c.type) {
    case "horizontal": return { icon: "horizontal", name: "Horizontal", operands: [c.line] };
    case "vertical": return { icon: "vertical", name: "Vertical", operands: [c.line] };
    case "parallel": return { icon: "parallel", name: "Parallel", operands: [c.l1, c.l2] };
    case "perpendicular": return { icon: "perpendicular", name: "Perpendicular", operands: [c.l1, c.l2] };
    case "collinear": return { icon: "collinear", name: "Collinear", operands: [c.l1, c.l2] };
    case "equal": return { icon: "equal", name: "Equal", operands: [c.l1, c.l2] };
    case "equalRadius": return { icon: "equal", name: "Equal radius", operands: [c.a, c.b] };
    case "tangent": return { icon: "tangent", name: "Tangent", operands: [c.line, c.circle] };
    case "tangent2": return { icon: "tangent", name: "Tangent", operands: [c.a, c.b] };
    case "coincident": return { icon: "coincident", name: "Coincident", operands: [c.e1, c.e2] };
    case "concentric": return { icon: "concentric", name: "Concentric", operands: [c.c1, c.c2] };
    case "midpoint": return { icon: "midpoint", name: "Midpoint", operands: [c.e, c.line] };
    case "symmetric": return { icon: "symmetric", name: "Symmetric", operands: [c.e1, c.e2, c.line] };
    case "fix": return { icon: "fix", name: "Fixed", operands: [c.e] };
    // The dimensional constraints have no glyph, they ARE their badge on the
    // canvas, but a list that showed only the geometric half would be lying
    // about what is holding the sketch.
    case "distance": return { icon: "distance", name: "Length", operands: [c.line] };
    case "diameter": return { icon: "diameter", name: "Diameter", operands: [c.circle] };
    case "radius": return { icon: "radius", name: "Radius", operands: [c.e] };
    case "angle": return { icon: "angle", name: "Angle", operands: [c.l1, c.l2] };
    case "p2pDistance": return { icon: "distance", name: "Distance", operands: [c.e1, c.e2] };
    case "p2lDistance": return { icon: "distance", name: "Distance to line", operands: [c.e, c.line] };
    case "radialGap": return { icon: "distance", name: "Radial gap", operands: [c.inner, c.outer] };
    case "c2cDistance": return { icon: "distance", name: "Rim to rim", operands: [c.c1, c.c2] };
    case "c2lDistance": return { icon: "distance", name: "Rim to line", operands: [c.circle, c.line] };
    case "p2cDistance": return { icon: "distance", name: "Point to rim", operands: [c.e, c.circle] };
    default: return { icon: "warning", name: (c as { type: string }).type, operands: [] };
  }
}

/** representative point of an entity for glyph placement */
function entCenter(e: ResolvedEntity): THREE.Vector2 {
  switch (e.type) {
    case "line": return V((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2);
    case "arc": return V(e.mx, e.my);
    case "circle": case "point": case "rectangle": case "text": return V(e.x, e.y);
    case "polygon": return V(e.x, e.y);
    case "slot": return V((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2);
    case "spline": { const p = e.points[Math.floor(e.points.length / 2)] ?? e.points[0]; return p ? V(p.x, p.y) : V(0, 0); }
    case "projected": {
      const cv = e.curve;
      if (cv.kind === "line") return V((cv.x1 + cv.x2) / 2, (cv.y1 + cv.y2) / 2);
      if (cv.kind === "circle") return V(cv.x, cv.y);
      if (cv.kind === "arc") return V(cv.mx, cv.my);
      const p = cv.pts[Math.floor(cv.pts.length / 2)] ?? cv.pts[0];
      return p ? V(p[0], p[1]) : V(0, 0);
    }
  }
}

export function constraintGlyphs(ents: ResolvedEntity[], constraints: SketchConstraint[]): ConstraintGlyph[] {
  const byId = new Map(ents.map((e) => [e.id, e]));
  const out: ConstraintGlyph[] = [];
  const center = (id: string): THREE.Vector2 | null => { const e = byId.get(id); return e ? entCenter(e) : null; };
  const refPos = (id: string, p: number): THREE.Vector2 | null => {
    const e = byId.get(id);
    return e ? refPoint(e, p) : null;
  };
  const mid2 = (a: THREE.Vector2 | null, b: THREE.Vector2 | null) => (a && b ? a.clone().add(b).multiplyScalar(0.5) : null);
  const push = (i: number, icon: string, pos: THREE.Vector2 | null) => { if (pos) out.push({ cIndex: i, icon, pos }); };

  constraints.forEach((c, i) => {
    switch (c.type) {
      case "horizontal": push(i, constraintFace(c).icon, center(c.line)); break;
      case "vertical": push(i, constraintFace(c).icon, center(c.line)); break;
      case "parallel": push(i, constraintFace(c).icon, center(c.l1)); break;
      case "perpendicular": push(i, constraintFace(c).icon, center(c.l1)); break;
      case "collinear": push(i, constraintFace(c).icon, mid2(center(c.l1), center(c.l2))); break;
      case "equal": push(i, constraintFace(c).icon, center(c.l1)); break;
      case "equalRadius": push(i, constraintFace(c).icon, center(c.a)); break;
      case "tangent": push(i, constraintFace(c).icon, mid2(center(c.line), center(c.circle))); break;
      case "tangent2": push(i, constraintFace(c).icon, mid2(center(c.a), center(c.b))); break;
      case "coincident": push(i, constraintFace(c).icon, refPos(c.e1, c.p1)); break;
      case "concentric": push(i, constraintFace(c).icon, center(c.c1)); break;
      case "midpoint": push(i, constraintFace(c).icon, center(c.line)); break;
      case "symmetric": push(i, constraintFace(c).icon, center(c.line)); break;
      case "fix": push(i, constraintFace(c).icon, refPos(c.e, c.p)); break;
      // distance/diameter/p2pDistance/p2lDistance/radius/angle render as dimensions
      default: break;
    }
  });
  return out;
}
