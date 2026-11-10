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
      tool("line", "tool.line", "line", { key: "L" }),
      // Each rectangle and circle trio is one shape anchored differently (corner, centre, edge), so each folds into one
      // split button that remembers the last used.
      split("tool.rectangle", [
        tool("rectangle", "tool.rectangle", "rectangle", { key: "R" }),
        tool("centerRectangle", "tool.centerRectangle", "centerRectangle"),
        tool("rectangle3", "tool.rect3Pt", "rectangle3"),
      ]),
      split("tool.circle", [
        tool("circle", "tool.circle", "circle", { key: "C" }),
        tool("circle2", "tool.circle2", "circle2"),
        tool("circle3", "tool.circle3", "circle3"),
      ]),
      tool("arc", "tool.arc", "arc", { key: "A" }),
      tool("polygon", "tool.polygon", "polygon"),
      tool("slot", "tool.slot", "slot"),
      split("tool.spline", [
        tool("spline", "tool.spline", "spline"),
        tool("bspline", "tool.controlPointSpline", "bspline"),
      ]),
      tool("point", "tool.point", "point"),
      tool("text", "tool.text", "text"),
      tool("project", "tool.project", "project", { key: "P" }),
    ],
  },
  {
    label: "MODIFY",
    items: [
      tool("fillet-sketch", "tool.fillet", "fillet", { key: "F" }),
      tool("chamfer-sketch", "tool.chamfer", "chamfer"),
      tool("trim", "tool.trim", "trim", { key: "T" }),
      tool("extend", "tool.extend", "extend"),
      tool("offset", "tool.offset", "offset", { key: "O" }),
      tool("break", "tool.break", "break"),
      tool("mirror-sketch", "tool.mirror", "mirror"),
      tool("move-sketch", "tool.moveRotate", "move", { key: "M" }),
      tool("copy-sketch", "tool.copy", "copy"),
      tool("rotate-sketch", "tool.rotate", "rotate"),
      tool("scale-sketch", "tool.scale", "scale"),
      tool("dimension", "tool.dimension", "dimension", { key: "D" }),
    ],
  },
  {
    label: "PATTERN",
    items: [
      tool("patternLinear", "tool.linearPattern", "patternLinear"),
      tool("patternCircular", "tool.circularPat", "patternCircular"),
      tool("patternRect", "tool.rectPattern", "patternRect"),
      tool("boltCircle", "tool.boltCircle", "boltCircle"),
      tool("hexHoles", "tool.staggeredHoles", "hexHoles"),
      tool("honeycomb", "tool.honeycomb", "honeycomb"),
      tool("gridHoles", "tool.gridHoles", "gridHoles"),
    ],
  },
  {
    label: "CONSTRAINTS",
    items: [
      split(
        "tool.family.constrain",
        // The hint is read from the keymap, as for the booleans, since some carry Shift.
        (
          [
            ["horizontal", "tool.horizontal"],
            ["vertical", "tool.vertical"],
            ["parallel", "tool.parallel"],
            ["perpendicular", "tool.perpendicular"],
            ["equal", "tool.equal"],
            ["tangent", "tool.tangent"],
            ["coincident", "tool.coincident"],
            ["concentric", "tool.concentric"],
            ["midpoint", "tool.midpoint"],
            ["collinear", "tool.collinear"],
            ["symmetric", "tool.symmetric"],
            ["fix", "tool.fix"],
          ] as const
        ).map(([action, labelKey]) => {
          const key = keyHint(action);
          return tool(action, labelKey, action, key !== undefined ? { key } : {});
        }),
      ),
      tool("tie-loose-ends", "tool.tieLooseEnds", "coincident"),
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
