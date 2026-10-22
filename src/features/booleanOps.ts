// Union, Subtract and Intersect are declared once so the ribbon, keys, right-click menu and selection toolbar
// all offer the same three. The names are the button words; the engine translates to OCCT's fuse/cut/common.

import type { Feature } from "../types";

export type BooleanOp = Extract<Feature, { type: "boolean" }>["operation"];

export interface BooleanCommand {
  op: BooleanOp;
  /** The button word, also used in a refusal. */
  label: string;
  /** The same id in app/actions.ts and features/toolCapabilities.ts, which lets the selection toolbar run an offer. */
  action: string;
  /** Name in ui/icons.ts. */
  iconName: string;
}

/** Declaration order is the offer order on every surface, most used first. */
export const BOOLEAN_COMMANDS: readonly BooleanCommand[] = [
  { op: "union", label: "Union", action: "boolean-union", iconName: "booleanUnion" },
  { op: "subtract", label: "Subtract", action: "boolean-subtract", iconName: "booleanSubtract" },
  { op: "intersect", label: "Intersect", action: "boolean-intersect", iconName: "booleanIntersect" },
];

export const BOOLEAN_LABEL: Record<BooleanOp, string> = {
  union: "Union",
  subtract: "Subtract",
  intersect: "Intersect",
};

/** Null rather than throwing, since the dispatcher asks about every action. */
export function booleanOpOfAction(action: string): BooleanOp | null {
  return BOOLEAN_COMMANDS.find((c) => c.action === action)?.op ?? null;
}
