// The ribbon's tools, groups and collapse order, apart from the component so ui/commands.ts can use the same tables.

import { contributedRibbon } from "../plugins/contrib";
import { BOOLEAN_COMMANDS } from "../features/booleanOps";
import { keyHint } from "../input/shortcuts";
import { t, tEnglish, type MessageKey } from "../i18n";

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

const TOOL_KEYS = new Map<string, MessageKey>();

// A getter, so the label follows a change of language; the key is kept for the English alias.
function tool(action: string, labelKey: MessageKey, iconName: string, opts: { key?: string } = {}): ToolItem {
  TOOL_KEYS.set(action, labelKey);
  return {
    action,
    iconName,
    ...(opts.key !== undefined ? { key: opts.key } : {}),
    get label() {
      return t(labelKey);
    },
  };
}

function split(labelKey: MessageKey, children: ToolItem[]): SplitItem {
  return {
    get label() {
      return t(labelKey);
    },
    children,
  };
}

const BOOLEAN_KEYS = { union: "tool.union", subtract: "tool.subtract", intersect: "tool.intersect" } as const;

// Group labels are ids, so the display text is looked up here.
const GROUP_KEYS: Record<string, MessageKey> = {
  CREATE: "tool.group.create",
  MODIFY: "tool.group.modify",
  CONSTRUCT: "tool.group.construct",
  INSPECT: "tool.group.inspect",
  INSERT: "tool.group.insert",
  PATTERN: "tool.group.pattern",
  CONSTRAINTS: "tool.group.constraints",
};

/** The live name of a built in tool, undefined for one the tables do not carry (a plugin's). */
export function toolLabel(action: string): string | undefined {
  const key = TOOL_KEYS.get(action);
  return key ? t(key) : undefined;
}

export function toolEnglish(action: string): string | undefined {
  const key = TOOL_KEYS.get(action);
  return key ? tEnglish(key) : undefined;
}

export function groupName(id: string): string | undefined {
  const key = Object.hasOwn(GROUP_KEYS, id) ? GROUP_KEYS[id] : undefined;
  return key ? t(key) : undefined;
}

export function groupEnglish(id: string): string | undefined {
  const key = Object.hasOwn(GROUP_KEYS, id) ? GROUP_KEYS[id] : undefined;
  return key ? tEnglish(key) : undefined;
}

export const MODEL: Group[] = [
  {
    label: "CREATE",
    items: [
      tool("sketch", "tool.sketch", "sketch", { key: "S" }),
      tool("extrude", "tool.extrude", "extrude", { key: "E" }),
      tool("primitive", "tool.primitive", "primitive"),
      split("tool.revolve", [
        tool("revolve", "tool.revolve", "revolve"),
        tool("loft", "tool.loft", "loft"),
        tool("sweep", "tool.sweep", "sweep"),
      ]),
    ],
  },
  {
    label: "MODIFY",
    items: [
      tool("presspull", "tool.pressPull", "presspull", { key: "Q" }),
      tool("fillet", "tool.fillet", "fillet", { key: "F" }),
      tool("chamfer", "tool.chamfer", "chamfer", { key: "B" }),
      tool("hole", "tool.hole", "hole"),
      split("tool.move", [
        tool("move", "tool.move", "move", { key: "M" }),
        tool("scale", "tool.scale", "scale"),
        tool("mirror", "tool.mirror", "mirror"),
        tool("joint", "tool.joint", "assembly"),
        tool("mechanism", "tool.mechanism", "mechanism"),
        // Two entries: linear and circular are different gestures, so the choice belongs on the button.
        tool("pattern-linear", "tool.linearPattern", "patternLinear"),
        tool("pattern-circular", "tool.circularPattern", "patternCircular"),
        tool("pattern-rect", "tool.rectPattern", "patternRect"),
      ]),
      // Split Body is not a boolean: it cuts one body with a plane, so it stands on its own.
      split(
        "tool.family.boolean",
        // Hints are read from the keymap, since the booleans' keys carry a modifier a hand-written "U" would misstate.
        BOOLEAN_COMMANDS.map((c) => {
          const key = keyHint(c.action);
          return tool(c.action, BOOLEAN_KEYS[c.op], c.iconName, key !== undefined ? { key } : {});
        }),
      ),
      tool("split", "tool.splitBody", "split", { key: "K" }),
      tool("separate", "tool.separate", "split"),
      split("tool.shell", [
        tool("shell", "tool.shell", "shell"),
        tool("draft", "tool.draft", "draft"),
        tool("thread", "tool.thread", "thread"),
        tool("text-on-face", "tool.textOnFace", "text"),
        tool("offset-face", "tool.offsetFace", "offsetFace"),
        tool("thicken", "tool.thicken", "thicken"),
      ]),
      tool("change-parameters", "tool.parameters", "parameters"),
    ],
  },
  {
    label: "CONSTRUCT",
    items: [
      tool("offset-plane", "tool.offsetPlane", "offsetPlane", { key: "O" }),
      split("tool.family.plane", [
        tool("datum-plane", "tool.datumPlane", "datumPlane"),
        tool("midplane", "tool.midplane", "midplane"),
        tool("plane-points", "tool.planePoints", "planePoints"),
        tool("plane-normal-edge", "tool.normalToEdge", "datumPlane"),
        tool("plane-two-edges", "tool.planeTwoEdges", "datumPlane"),
        tool("plane-angle", "tool.planeAtAngle", "datumPlane"),
      ]),
      split("tool.family.datum", [
        tool("datum-point", "tool.datumPoint", "datumPoint"),
        tool("datum-axis", "tool.datumAxis", "datumAxis"),
        tool("datum-axis-edge", "tool.axisOnEdge", "datumAxis"),
        tool("axis-cylinder", "tool.axisOfCylinder", "datumAxis"),
        tool("axis-planes", "tool.axisTwoPlanes", "datumAxis"),
      ]),
    ],
  },
  {
    label: "INSPECT",
    items: [
      tool("measure", "tool.measure", "measure", { key: "I" }),
      tool("section", "tool.section", "section"),
      split("tool.family.analyze", [
        tool("properties", "tool.properties", "properties"),
        tool("interference", "tool.interference", "interference"),
        tool("stress", "tool.stress", "stress"),
        tool("draft-analysis", "tool.overhang", "draftAnalysis"),
        tool("zebra", "tool.zebra", "zebra"),
        tool("curvature", "tool.curvature", "curvature"),
        tool("component-colors", "tool.bodyColors", "componentColors"),
      ]),
      // Beside Zebra, Curvature and Body Colors, ways of looking at the model; in the Edit menu alone nobody found it.
      tool("materials", "tool.materials", "material"),
    ],
  },
  {
    label: "INSERT",
    items: [
      tool("import", "tool.importMesh", "import"),
      tool("insert-document", "tool.insertDocument", "insertDocument"),
      tool("simplify-mesh", "tool.simplifyMesh", "simplifyMesh"),
      tool("clean-up", "tool.cleanUp", "cleanUp", { key: "U" }),
      tool("compute-all", "tool.computeAll", "computeAll"),
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
      { action: "patternLinear", label: "Linear Pattern", iconName: "patternLinear" },
      { action: "patternCircular", label: "Circular Pat.", iconName: "patternCircular" },
      { action: "patternRect", label: "Rect Pattern", iconName: "patternRect" },
      { action: "boltCircle", label: "Bolt Circle", iconName: "boltCircle" },
      { action: "hexHoles", label: "Staggered Holes", iconName: "hexHoles" },
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
