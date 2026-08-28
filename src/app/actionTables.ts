import type { SketchTool } from "../sketch/sketchMode";

/** Ribbon/keymap actions that create sketch geometry. Inside a sketch they
 *  switch the active tool; outside one they start a sketch with that tool. */
export const SKETCH_TOOLS = new Set([
  "line", "rectangle", "centerRectangle", "rectangle3", "circle", "circle2", "circle3",
  "arc", "polygon", "slot", "spline", "point", "text", "project",
  "boltCircle", "hexHoles", "gridHoles", "patternRect", "patternCircular", "honeycomb",
]);

/** Sketch MODIFY tools (ribbon action -> sketch tool name). Only meaningful
 *  inside a sketch. */
export const SKETCH_MODIFY: Record<string, SketchTool> = {
  trim: "trim",
  "fillet-sketch": "fillet",
  "chamfer-sketch": "chamfer",
  offset: "offset",
  extend: "extend",
  break: "break",
  "mirror-sketch": "mirror",
  "move-sketch": "move",
  "copy-sketch": "copy",
  "rotate-sketch": "rotate",
  "scale-sketch": "scale",
  dimension: "dimension",
  horizontal: "horizontal",
  vertical: "vertical",
  parallel: "parallel",
  perpendicular: "perpendicular",
  equal: "equal",
  tangent: "tangent",
  coincident: "coincident",
  concentric: "concentric",
  midpoint: "midpoint",
  collinear: "collinear",
  symmetric: "symmetric",
  fix: "fix",
};

/** "Repeat <last command>" (Onshape-style): the empty-space menu re-runs the last
 *  real command. Navigation / view / file actions aren't commands you repeat, so
 *  they don't overwrite it. */
export const NON_REPEATABLE = new Set([
  "new", "open", "save", "saveas", "export", "import",
  "print-export", "print-orca", "print-send", "welcome", "ta-publish",
  "undo", "redo", "compute-all", "shortcut-help", "finish", "palette",
  "fit", "iso", "top", "front", "right", "persp",
  "selmode", "selmode-faces", "selmode-bodies", "toggle-xray",
  "hide-selected", "show-all-bodies",
]);

/** Per-tool instruction line shown in the viewport prompt while sketching. */
export const SKETCH_PROMPTS: Record<string, string> = {
  select: "Line (L) · Rectangle (R) · Circle (C) · Arc (A) · Trim (T)",
  line: "Click points · length Tab angle · Enter · Esc",
  rectangle: "Click two corners · W Tab H · Enter · Esc",
  circle: "Click centre, then radius · type ⌀ · Enter · Esc",
  arc: "Click start, end, then a point on the arc · Esc",
  spline: "Click fit points · Enter to finish · Esc",
  point: "Click to place a point · Esc",
  polygon: "Click the centre, then a vertex · Esc",
  slot: "Click the two arc centres, then the width · Esc",
  circle2: "Click two points on the diameter · Esc",
  circle3: "Click three points on the circle · Esc",
  centerRectangle: "Click the centre, then a corner · Esc",
  rectangle3: "Click both ends of one edge, then the thickness · Esc",
  mirror: "Select entities, then click the mirror line · Esc",
  dimension: "Click a line or circle, type a value · Enter · Esc",
  trim: "Click a curve to trim to its crossings · Esc",
  fillet: "Click two lines, type a radius · Enter · Esc",
  chamfer: "Click two lines, type a setback · Enter · Esc",
  offset: "Click a curve, type a distance · Enter · Esc",
  extend: "Click a line or arc near an end · Esc",
  break: "Click a line or arc to split it · Esc",
  move: "Select entities, then click from and to · Esc",
  copy: "Select entities, then click from and to · Esc",
  rotate: "Select entities, click a centre, type an angle · Esc",
  scale: "Select entities, click a base point, type a factor · Esc",
  horizontal: "Click a line · Esc",
  vertical: "Click a line · Esc",
  parallel: "Click two lines · Esc",
  perpendicular: "Click two lines · Esc",
  equal: "Click two lines, or two circles/arcs · Esc",
  tangent: "Click two curves · Esc",
  coincident: "Click two endpoints · Esc",
  concentric: "Click two circles or arcs · Esc",
  midpoint: "Click a point, then a line · Esc",
  collinear: "Click two lines · Esc",
  symmetric: "Click two endpoints, then the axis · Esc",
  fix: "Click a point or a circle centre to lock it · Esc",
};
