// The three booleans, in one place: Union, Subtract, Intersect.
//
// They arrived as three commands replacing one command with a dialog. That is
// only an improvement if all three are equally reachable — a ribbon entry, a
// key, a right-click item, a toolbar button on a two-body selection — and the
// way that goes wrong is a fourth surface learning about two of them. So the
// pairing of an operation with its word, its action id and its mark is declared
// here, and every surface reads it.
//
// The operation names are the words on the buttons, not the kernel's. OCCT
// calls them fuse/cut/common and the old Combine feature called them
// join/cut/intersect; the sidecar still translates at its own edge. What a user
// selects two bodies and asks for is a union.

import type { Feature } from "../types";

export type BooleanOp = Extract<Feature, { type: "boolean" }>["operation"];

export interface BooleanCommand {
  op: BooleanOp;
  /** The word on the button, and the word in a refusal. */
  label: string;
  /** The id app/actions.ts dispatches, and the id features/toolCapabilities.ts
   *  gives the tool — those two being the same string is what lets the selection
   *  toolbar run an offer it was handed. */
  action: string;
  /** Name in ui/icons.ts. */
  iconName: string;
}

/** Declaration order is the order they are offered everywhere: the ribbon's
 *  split button, the right-click menu, the selection toolbar. Union first
 *  because it is the one people reach for most, Intersect last because it is the
 *  one people reach for least. */
export const BOOLEAN_COMMANDS: readonly BooleanCommand[] = [
  { op: "union", label: "Union", action: "boolean-union", iconName: "booleanUnion" },
  { op: "subtract", label: "Subtract", action: "boolean-subtract", iconName: "booleanSubtract" },
  { op: "intersect", label: "Intersect", action: "boolean-intersect", iconName: "booleanIntersect" },
];

/** The word for an operation. */
export const BOOLEAN_LABEL: Record<BooleanOp, string> = {
  union: "Union",
  subtract: "Subtract",
  intersect: "Intersect",
};

/** The operation an action id asks for, or null when it is not one of ours.
 *
 *  The dispatcher's half of the pairing above. It returns null rather than
 *  throwing because it is asked about every action the app has. */
export function booleanOpOfAction(action: string): BooleanOp | null {
  return BOOLEAN_COMMANDS.find((c) => c.action === action)?.op ?? null;
}
