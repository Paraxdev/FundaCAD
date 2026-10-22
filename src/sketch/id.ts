// Stable entity ids, so constraints never point by array index at geometry a modify op reordered or split.
// One per-session counter for all families; note() bumps it past loaded ids so new ones never collide.

import type { SketchConstraint } from "../types";

let counter = 0;

function idFamily(prefix: string) {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  return {
    next: (): string => `${prefix}${counter++}`,
    note: (id: string | undefined): void => {
      if (!id) return;
      const m = re.exec(id);
      if (m) counter = Math.max(counter, Number(m[1]) + 1);
    },
  };
}

const entity = idFamily("e");
export const newEntityId = entity.next;
export const noteEntityId = entity.note;

/** Pattern ids: `p` prefix, so a pattern id and its derived entities ("p3#0")
 *  never collide with entity ids ("e3"). */
const pattern = idFamily("p");
export const newPatternId = pattern.next;
export const notePatternId = pattern.note;

/** Constraint ids (dimension constraints only): the stable identity a parameter
 *  binding references, the constraint array itself is spliced by edits. */
const constraint = idFamily("c");
export const newConstraintId = constraint.next;
export const noteConstraintId = constraint.note;

/** Value-bearing constraints carry a stable c-id; the load migration and the editor both stamp through this. */
export function isDimConstraint(c: SketchConstraint): c is SketchConstraint & { id?: string; value: number } {
  return "value" in c;
}
