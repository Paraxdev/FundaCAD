// The ribbon's tools, groups and collapse order, apart from the component so ui/commands.ts can use the same tables.

import { contributedRibbon } from "../plugins/contrib";
import { BOOLEAN_COMMANDS } from "../features/booleanOps";
import { keyHint } from "../input/shortcuts";

export type RibbonContext = "model" | "sketch";

interface ToolItem {
  action: string;
  label: string;
  iconName: string;
  key?: string;
  kind?: "finish" | "toggle";
}
// Split button: `children` holds every tool, children[0] is the initial primary and `label` names the family for the
// arrow tooltip. Picking a child runs it and makes it the primary.
interface SplitItem {
  label: string;
  children: ToolItem[];
}
type Item = ToolItem | SplitItem;
interface Group {
  label: string;
  items: Item[];
}
export type { Item, ToolItem, Group };

/** a split button's tools, or the item itself, every consumer that needs the
 *  flat tool list (palette, overflow popup) goes through this. */
export function leavesOf(it: Item): ToolItem[] {
  return "children" in it ? it.children : [it];
}

export const MODEL: Group[] = [
  {
    label: "CREATE",
    items: [
      { action: "sketch", label: "Sketch", iconName: "sketch", key: "S" },
      { action: "extrude", label: "Extrude", iconName: "extrude", key: "E" },
      { action: "primitive", label: "Primitive", iconName: "primitive" },
      {
        label: "Revolve",
        children: [
          { action: "revolve", label: "Revolve", iconName: "revolve" },
          { action: "loft", label: "Loft", iconName: "loft" },
          { action: "sweep", label: "Sweep", iconName: "sweep" },
        ],
      },
    ],
  },
  {
    label: "MODIFY",
    items: [
      { action: "presspull", label: "Press/Pull", iconName: "presspull", key: "Q" },
      { action: "fillet", label: "Fillet", iconName: "fillet", key: "F" },
      { action: "chamfer", label: "Chamfer", iconName: "chamfer", key: "B" },
      { action: "hole", label: "Hole", iconName: "hole" },
      {
        label: "Move",
        children: [
          { action: "move", label: "Move", iconName: "move", key: "M" },
          { action: "scale", label: "Scale", iconName: "scale" },
          { action: "mirror", label: "Mirror", iconName: "mirror" },
          { action: "joint", label: "Joint", iconName: "assembly" },
          { action: "mechanism", label: "Mechanism", iconName: "mechanism" },
          // Two entries: linear and circular are different gestures, so the choice belongs on the button.
          { action: "pattern-linear", label: "Linear Pattern", iconName: "patternLinear" },
          { action: "pattern-circular", label: "Circular Pattern", iconName: "patternCircular" },
        ],
      },
      // Split Body is not a boolean: it cuts one body with a plane, so it stands on its own.
      {
        label: "Boolean",
        // Hints are read from the keymap, since the booleans' keys carry a modifier a hand-written "U" would misstate.
        children: BOOLEAN_COMMANDS.map((c) => {
          const key = keyHint(c.action);
          return {
            action: c.action,
            label: c.label,
            iconName: c.iconName,
            ...(key !== undefined ? { key } : {}),
          };
        }),
      },
      { action: "split", label: "Split Body", iconName: "split", key: "K" },
      { action: "separate", label: "Separate", iconName: "split" },
      {
        label: "Shell",
        children: [
          { action: "shell", label: "Shell", iconName: "shell" },
          { action: "draft", label: "Draft", iconName: "draft" },
          { action: "thread", label: "Thread", iconName: "thread" },
          { action: "text-on-face", label: "Text on Face", iconName: "text" },
          { action: "offset-face", label: "Offset Face", iconName: "offsetFace" },
          { action: "thicken", label: "Thicken", iconName: "thicken" },
        ],
      },
      { action: "change-parameters", label: "Parameters", iconName: "parameters" },
    ],
  },
  {
    label: "CONSTRUCT",
    items: [
      { action: "offset-plane", label: "Offset Plane", iconName: "offsetPlane", key: "O" },
      {
        label: "Plane",
        children: [
          { action: "datum-plane", label: "Datum Plane", iconName: "datumPlane" },
          { action: "midplane", label: "Midplane", iconName: "midplane" },
          { action: "plane-points", label: "Plane, 3 Pts", iconName: "planePoints" },
          { action: "plane-normal-edge", label: "Normal to Edge", iconName: "datumPlane" },
          { action: "plane-two-edges", label: "Plane, 2 Edges", iconName: "datumPlane" },
          { action: "plane-angle", label: "Plane at Angle", iconName: "datumPlane" },
        ],
      },
      {
        label: "Datum",
        children: [
          { action: "datum-point", label: "Datum Point", iconName: "datumPoint" },
          { action: "datum-axis", label: "Datum Axis", iconName: "datumAxis" },
          { action: "datum-axis-edge", label: "Axis on Edge", iconName: "datumAxis" },
          { action: "axis-cylinder", label: "Axis of Cylinder", iconName: "datumAxis" },
          { action: "axis-planes", label: "Axis, 2 Planes", iconName: "datumAxis" },
        ],
      },
    ],
  },
  {
    label: "INSPECT",
    items: [
      { action: "measure", label: "Measure", iconName: "measure", key: "I" },
      { action: "section", label: "Section", iconName: "section" },
      {
        label: "Analyze",
        children: [
          { action: "properties", label: "Properties", iconName: "properties" },
          { action: "interference", label: "Interference", iconName: "interference" },
          { action: "stress", label: "Stress", iconName: "stress" },
          { action: "draft-analysis", label: "Overhang", iconName: "draftAnalysis" },
          { action: "zebra", label: "Zebra", iconName: "zebra" },
          { action: "curvature", label: "Curvature", iconName: "curvature" },
          { action: "component-colors", label: "Body Colors", iconName: "componentColors" },
        ],
      },
      // Beside Zebra, Curvature and Body Colors, ways of looking at the model; in the Edit menu alone nobody found it.
      { action: "materials", label: "Materials", iconName: "material" },
    ],
  },
  {
    label: "INSERT",
    items: [
      { action: "import", label: "Import Mesh", iconName: "import" },
      { action: "insert-document", label: "Insert Document", iconName: "insertDocument" },
      { action: "simplify-mesh", label: "Simplify Mesh", iconName: "simplifyMesh" },
      { action: "clean-up", label: "Clean Up", iconName: "cleanUp", key: "U" },
      { action: "compute-all", label: "Compute All", iconName: "computeAll" },
    ],
  },
];

/** Below every app group, so a contributed group folds into the overflow before the modelling tools do. */
const CONTRIBUTED_PRIORITY = 10;

/** The app's own groups plus what running plugins add; MODEL stays the full app definition. Contributed groups go at
 *  the end in plugin start order, merged by heading so two PRINT groups share one. */
export function modelGroups(): Group[] {
  const extra = contributedRibbon();
  if (!extra.length) return MODEL;
  const out: Group[] = MODEL.map((g) => ({ ...g, items: [...g.items] }));
  for (const c of extra) {
    const existing = out.find((g) => g.label === c.group);
    if (existing) existing.items.push(...c.items);
    else out.push({ label: c.group, items: [...c.items] });
  }
  return out.filter((g) => g.items.length > 0);
}

/** Collapse priority for a group, contributed or not. Read by the ribbon bar in
 *  place of PRIORITY, which only knows the app's own headings. */
export function priorityOf(group: string): number {
  const own = PRIORITY[group];
  if (own !== undefined) return own;
  const c = contributedRibbon().find((x) => x.group === group);
  return c?.priority ?? CONTRIBUTED_PRIORITY;
}

export const SKETCH: Group[] = [
  {
    label: "CREATE",
    items: [
      { action: "line", label: "Line", iconName: "line", key: "L" },
      // Each rectangle and circle trio is one shape anchored differently (corner, centre, edge), so each folds into one
      // split button that remembers the last used.
      {
        label: "Rectangle",
        children: [
          { action: "rectangle", label: "Rectangle", iconName: "rectangle", key: "R" },
          { action: "centerRectangle", label: "Center Rect", iconName: "centerRectangle" },
          { action: "rectangle3", label: "Rect 3-Pt", iconName: "rectangle3" },
        ],
      },
      {
        label: "Circle",
        children: [
          { action: "circle", label: "Circle", iconName: "circle", key: "C" },
          { action: "circle2", label: "Circle 2-Pt", iconName: "circle2" },
          { action: "circle3", label: "Circle 3-Pt", iconName: "circle3" },
        ],
      },
      { action: "arc", label: "Arc", iconName: "arc", key: "A" },
      { action: "polygon", label: "Polygon", iconName: "polygon" },
      { action: "slot", label: "Slot", iconName: "slot" },
      {
        label: "Spline",
        children: [
          { action: "spline", label: "Spline", iconName: "spline" },
          { action: "bspline", label: "Control Point Spline", iconName: "bspline" },
        ],
      },
      { action: "point", label: "Point", iconName: "point" },
      { action: "text", label: "Text", iconName: "text" },
      { action: "project", label: "Project", iconName: "project", key: "P" },
    ],
  },
  {
    label: "MODIFY",
    items: [
      { action: "fillet-sketch", label: "Fillet", iconName: "fillet", key: "F" },
      { action: "chamfer-sketch", label: "Chamfer", iconName: "chamfer" },
      { action: "trim", label: "Trim", iconName: "trim", key: "T" },
      { action: "extend", label: "Extend", iconName: "extend" },
      { action: "offset", label: "Offset", iconName: "offset", key: "O" },
      { action: "break", label: "Break", iconName: "break" },
      { action: "mirror-sketch", label: "Mirror", iconName: "mirror" },
      { action: "move-sketch", label: "Move/Rotate", iconName: "move", key: "M" },
      { action: "copy-sketch", label: "Copy", iconName: "copy" },
      { action: "rotate-sketch", label: "Rotate", iconName: "rotate" },
      { action: "scale-sketch", label: "Scale", iconName: "scale" },
      { action: "dimension", label: "Dimension", iconName: "dimension", key: "D" },
    ],
  },
  {
    label: "PATTERN",
    items: [
      { action: "patternRect", label: "Rect Pattern", iconName: "patternRect" },
      { action: "patternCircular", label: "Circular Pat.", iconName: "patternCircular" },
      { action: "boltCircle", label: "Bolt Circle", iconName: "boltCircle" },
      { action: "hexHoles", label: "Hex Holes", iconName: "hexHoles" },
      { action: "honeycomb", label: "Honeycomb", iconName: "honeycomb" },
      { action: "gridHoles", label: "Grid Holes", iconName: "gridHoles" },
    ],
  },
  {
    label: "CONSTRAINTS",
    items: [
      {
        label: "Constrain",
        // the hint is read from the keymap, as for the booleans, since some carry Shift
        children: (
          [
            ["horizontal", "Horizontal"],
            ["vertical", "Vertical"],
            ["parallel", "Parallel"],
            ["perpendicular", "Perpendic."],
            ["equal", "Equal"],
            ["tangent", "Tangent"],
            ["coincident", "Coincident"],
            ["concentric", "Concentric"],
            ["midpoint", "Midpoint"],
            ["collinear", "Collinear"],
            ["symmetric", "Symmetric"],
            ["fix", "Fix"],
          ] as const
        ).map(([action, label]) => {
          const key = keyHint(action);
          return { action, label, iconName: action, ...(key !== undefined ? { key } : {}) };
        }),
      },
      { action: "tie-loose-ends", label: "Tie Loose Ends", iconName: "coincident" },
    ],
  },
];

// Collapse priority: lower numbers fold into the "⋯ More" overflow first. PALETTE
// and FINISH are pinned (never collapse, Finish Sketch must stay reachable).
export const PRIORITY: Record<string, number> = {
  CREATE: 100,
  MODIFY: 90,
  INSPECT: 45,
  CONSTRUCT: 40,
  INSERT: 30,
  CONSTRAINTS: 20,
};
export const PINNED = new Set(["PALETTE", "FINISH"]);
