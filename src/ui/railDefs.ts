// What the floating tool rail shows, built from the ribbon tables so a tool is
// still defined in exactly one place (ui/ribbonDefs.ts).
//
// Three modes: the model with nothing selected shows categories that open
// flyouts, a selection shows the tools that can act on it, and a sketch shows
// its own drawing tools with each family behind one button.

import { leavesOf, modelGroups, SKETCH, type Group, type ToolItem } from "./ribbonDefs";

export type RailMode = "model" | "selection" | "sketch";

export interface RailTool {
  kind: "tool";
  action: string;
  label: string;
  icon: string;
  keys?: string;
}

/** A button standing for several tools. A `variants` family runs the variant
 *  on its face and remembers the last one picked; a `category` only opens its
 *  flyout. */
export interface RailFamily {
  kind: "family";
  id: string;
  label: string;
  icon: string;
  style: "variants" | "category";
  items: RailTool[];
}

export type RailEntry = RailTool | RailFamily;

export function railTool(t: ToolItem): RailTool {
  return { kind: "tool", action: t.action, label: t.label, icon: t.iconName, ...(t.key ? { keys: t.key } : {}) };
}

const CATEGORY: Record<string, { label: string; icon: string }> = {
  CREATE: { label: "Create", icon: "primitive" },
  MODIFY: { label: "Modify", icon: "presspull" },
  CONSTRUCT: { label: "Construct", icon: "datumPlane" },
  INSPECT: { label: "Inspect", icon: "measure" },
  INSERT: { label: "Insert", icon: "import" },
};

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/** The model rail with nothing selected: Sketch on its own, then every ribbon
 *  group (the plugins' included) as a category. */
export function modelRail(groups: Group[] = modelGroups()): RailEntry[] {
  const out: RailEntry[] = [];
  for (const g of groups) {
    let tools = g.items.flatMap(leavesOf).map(railTool);
    const sketch = tools.find((t) => t.action === "sketch");
    if (sketch) {
      out.push(sketch);
      tools = tools.filter((t) => t !== sketch);
    }
    if (!tools.length) continue;
    const meta = CATEGORY[g.label];
    out.push({
      kind: "family",
      id: `cat:${g.label}`,
      label: meta?.label ?? titleCase(g.label),
      icon: meta?.icon ?? tools[0]!.icon,
      style: "category",
      items: tools,
    });
  }
  return out;
}

function sketchLeaf(action: string): ToolItem {
  for (const g of SKETCH) for (const it of g.items) for (const leaf of leavesOf(it)) if (leaf.action === action) return leaf;
  throw new Error(`sketch rail names an unknown tool: ${action}`);
}

type SketchSlot = string | { id: string; label: string; actions: readonly string[] };

const SKETCH_SLOTS: readonly SketchSlot[] = [
  "line",
  "arc",
  "spline",
  { id: "rectangle", label: "Rectangle", actions: ["rectangle", "centerRectangle", "rectangle3"] },
  { id: "circle", label: "Circle", actions: ["circle", "circle2", "circle3"] },
  "polygon",
  { id: "slot", label: "Slot", actions: ["slot", "point"] },
  { id: "offset", label: "Offset", actions: ["offset", "extend", "break"] },
  { id: "corner", label: "Fillet", actions: ["fillet-sketch", "chamfer-sketch"] },
  "move-sketch",
  "mirror-sketch",
  { id: "pattern", label: "Pattern", actions: ["patternRect", "patternCircular", "boltCircle", "hexHoles", "honeycomb", "gridHoles"] },
  "project",
  "text",
  "trim",
  "dimension",
  {
    id: "constrain",
    label: "Constrain",
    actions: ["horizontal", "vertical", "parallel", "perpendicular", "equal", "tangent", "coincident", "concentric", "midpoint", "collinear", "symmetric", "fix"],
  },
];

/** Sketch tools the rail leaves to the Move/Rotate gizmo and the command
 *  palette. */
export const SKETCH_OFF_RAIL: ReadonlySet<string> = new Set(["copy-sketch", "rotate-sketch", "scale-sketch"]);

export function sketchRail(): RailEntry[] {
  return SKETCH_SLOTS.map((slot): RailEntry => {
    if (typeof slot === "string") return railTool(sketchLeaf(slot));
    const items = slot.actions.map((a) => railTool(sketchLeaf(a)));
    return { kind: "family", id: `fam:${slot.id}`, label: slot.label, icon: items[0]!.icon, style: "variants", items };
  });
}

/** The variant a family's face runs: the one last picked, else the first. */
export function faceOf(f: RailFamily, chosen: string | undefined): RailTool {
  return (chosen && f.items.find((t) => t.action === chosen)) || f.items[0]!;
}

/** The family, if any, a sketch tool belongs to, so arming it from a key puts
 *  it on the face. */
export function familyOf(entries: readonly RailEntry[], action: string): RailFamily | null {
  for (const e of entries) if (e.kind === "family" && e.items.some((t) => t.action === action)) return e;
  return null;
}
