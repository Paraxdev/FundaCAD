// What one press of Escape means inside a sketch: a stack, most local first, so a half-drawn shape is never lost
// along with the session. The order is data here so vitest can pin it down without a canvas.

/** Booleans, not the live objects: the decision is only about WHETHER something is in flight. */
export interface SketchEscapeState {
  /** the offset tool is holding a picked curve, waiting for a distance */
  offsetPick: boolean;
  dragging: boolean;
  /** a half-finished entity, dimension pick or constraint pick is on screen */
  pendingGeometry: boolean;
  /** the Mirror panel is open; one press drops its picks and preview */
  mirror?: boolean;
  selection: boolean;
  /** the armed tool; "select" is the resting state a sketch idles in */
  tool: string;
  /** a menu or popover is open and closes on this press itself */
  overlay: boolean;
}

/** One rung per value, so the caller cannot do two at once (cancel the tool AND close the sketch on one key). */
export type SketchEscapeAction =
  | "none"
  | "cancel-offset"
  | "cancel-drag"
  | "cancel-geometry"
  | "cancel-mirror"
  | "clear-selection"
  | "arm-select"
  | "close";

/** "close" is reached only from a sketch idle in every sense, which is one Escape away from any other state,
 *  so leaving costs at most two presses. */
export function sketchEscapeAction(s: SketchEscapeState): SketchEscapeAction {
  if (s.overlay) return "none";
  if (s.offsetPick) return "cancel-offset";
  if (s.dragging) return "cancel-drag";
  if (s.pendingGeometry) return "cancel-geometry";
  if (s.mirror) return "cancel-mirror";
  if (s.selection) return "clear-selection";
  if (s.tool !== "select") return "arm-select";
  return "close";
}
