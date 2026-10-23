import type { ResolvedEntity } from "./snap";
import type { SketchConstraint } from "../types";
import { refPoint } from "./entityDims";

const APART = 1e-4;

/** A fillet, trim or move that separates a snap join's ends means to, so the join record is dropped rather than
 *  snapping them back. A Coincident the user applied stays and pulls the ends back. */
export function dropSeparatedJoins(
  before: readonly ResolvedEntity[],
  after: readonly ResolvedEntity[],
  constraints: SketchConstraint[],
): SketchConstraint[] {
  const was = new Map(before.map((e) => [e.id, e]));
  const now = new Map(after.map((e) => [e.id, e]));
  const at = (m: Map<string, ResolvedEntity>, id: string, p: number) => {
    const e = m.get(id);
    return e ? refPoint(e, p) : null;
  };
  return constraints.filter((c) => {
    if (c.type !== "coincident" || !c.snap) return true;
    const a0 = at(was, c.e1, c.p1),
      b0 = at(was, c.e2, c.p2);
    const a1 = at(now, c.e1, c.p1),
      b1 = at(now, c.e2, c.p2);
    if (!a0 || !b0 || !a1 || !b1) return true;
    return !(a0.distanceTo(b0) <= APART && a1.distanceTo(b1) > APART);
  });
}
