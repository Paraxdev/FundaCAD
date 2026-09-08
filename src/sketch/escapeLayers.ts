// What ONE press of Escape means inside a sketch.
//
// Escape in a sketcher is a stack, not a command: it undoes the most local thing
// you are in the middle of, and only when there is nothing local left does it
// leave. Collapsing that into a single answer is the classic way to lose work,
// an Escape that closes the sketch out from under a half-drawn rectangle throws
// the rectangle away AND the session with it, and the user pressed one key.
//
// The ORDER is the whole content of this file, so it lives here as data rather
// than as the shape of an if-chain buried in a 3900-line class: each rung is one
// named thing the user can be in the middle of, most local first. sketchMode.ts
// reads its own state into the record below and does what it is told, which is
// also what lets vitest pin the order down without a canvas, a camera or a
// document (the split features/edgeDragMath.ts makes for the edge gesture).

/** Everything about an open sketch that decides what Escape means. Booleans, not
 *  the objects themselves: the decision is about WHETHER something is in flight,
 *  and passing the live entity arrays in would let this file grow opinions about
 *  their contents. */
export interface SketchEscapeState {
  /** the offset tool is holding a picked curve, waiting for a distance */
  offsetPick: boolean;
  /** a drag of existing geometry is under way (revertible) */
  dragging: boolean;
  /** a half-finished entity, dimension pick or constraint pick is on screen */
  pendingGeometry: boolean;
  /** something is selected */
  selection: boolean;
  /** the armed tool; "select" is the resting state a sketch idles in */
  tool: string;
}

/** What the press does. One rung of the stack per value, so the caller cannot
 *  accidentally perform two of them (which is the bug: cancelling the tool AND
 *  closing the sketch on the same key). */
export type SketchEscapeAction =
  | "cancel-offset"
  | "cancel-drag"
  | "cancel-geometry"
  | "clear-selection"
  | "arm-select"
  | "close";

/** The rung this press lands on.
 *
 *  "close" is only ever reached from a sketch that is idle in every sense,
 *  select tool armed, nothing selected, nothing being drawn or dragged. That is
 *  the state the user is in when they mean "I'm done here", and it is exactly
 *  one Escape away from every other state, so leaving still costs at most two
 *  presses however deep you were. */
export function sketchEscapeAction(s: SketchEscapeState): SketchEscapeAction {
  if (s.offsetPick) return "cancel-offset";
  if (s.dragging) return "cancel-drag";
  if (s.pendingGeometry) return "cancel-geometry";
  if (s.selection) return "clear-selection";
  if (s.tool !== "select") return "arm-select";
  return "close";
}
