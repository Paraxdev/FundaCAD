// The ribbon's tool tables.
//
// Worth pinning because these tables are edited to REGROUP, not just to add:
// three rectangles and three circles were folded into split buttons so the
// sketch CREATE group stopped being fourteen buttons wide. A fold moves an
// action from a top-level item into a `children` array, and the two ways that
// goes wrong are both silent. Drop one and the tool is gone from the ribbon AND
// from the command palette, which builds its list from these same tables.
// Duplicate one and the palette offers it twice while the split button that owns
// it can be left showing a tool another button also runs.

import { describe, expect, it } from "vitest";
import { MODEL, SKETCH, leavesOf, type Group } from "../../src/ui/ribbonDefs";
import { allCommands } from "../../src/ui/commands";

const actionsOf = (groups: Group[]) => groups.flatMap((g) => g.items).flatMap(leavesOf).map((t) => t.action);

/** Every action a context offers, split-button children included. */
const contexts: [string, Group[]][] = [["model", MODEL], ["sketch", SKETCH]];

describe("ribbon tool tables", () => {
  it.each(contexts)("names each %s action exactly once", (_name, groups) => {
    const seen = actionsOf(groups);
    const dupes = seen.filter((a, i) => seen.indexOf(a) !== i);
    expect(dupes).toEqual([]);
  });

  it.each(contexts)("gives every %s tool a label and an icon", (_name, groups) => {
    for (const t of groups.flatMap((g) => g.items).flatMap(leavesOf)) {
      expect(t.action, `${t.action} label`).toBeTruthy();
      expect(t.label, `${t.action} label`).toBeTruthy();
      expect(t.iconName, `${t.action} icon`).toBeTruthy();
    }
  });

  it("names each command exactly once across the ribbon AND the global list", () => {
    // The per-table check above cannot see this one: a command written out in
    // commands.ts GLOBAL and then given a ribbon button is listed twice in the
    // palette, one entry filed under "View" and one under its group, and
    // whichever the user picks the other stays there looking like a second
    // thing. Materials moved exactly that way, out of the Edit menu's shadow
    // and onto the ribbon.
    const ids = allCommands().map((c) => c.id);
    const dupes = ids.filter((a, i) => ids.indexOf(a) !== i);
    expect(dupes).toEqual([]);
  });

  it("keeps Materials reachable now that it is not only in a menu", () => {
    expect(actionsOf(MODEL)).toContain("materials");
  });

  it("keeps every sketch drawing tool reachable after the rectangles and circles were folded", () => {
    // The list, not the count: a fold that dropped `rectangle3` would still
    // leave a plausible-looking ribbon, and the only thing that notices is a
    // user reaching for a tool that is no longer anywhere.
    expect(new Set(actionsOf(SKETCH))).toEqual(new Set([
      "line", "rectangle", "centerRectangle", "rectangle3",
      "circle", "circle2", "circle3", "arc", "polygon", "slot", "spline",
      "point", "text", "project",
      "fillet-sketch", "chamfer-sketch", "trim", "extend", "offset", "break",
      "mirror-sketch", "move-sketch", "copy-sketch", "rotate-sketch", "scale-sketch", "dimension",
      "patternRect", "patternCircular", "boltCircle", "hexHoles", "honeycomb", "gridHoles",
      "horizontal", "vertical", "parallel", "perpendicular", "equal", "tangent",
      "coincident", "concentric", "midpoint", "collinear", "symmetric", "fix",
    ]));
  });

  it("puts the three rectangles and the three circles on one button each", () => {
    // The point of the fold, stated as a fact about the table rather than about
    // the rendering: a family is a single item carrying children, which is what
    // makes it one button with one remembered default.
    const create = SKETCH.find((g) => g.label === "CREATE")!;
    const families = Object.fromEntries(
      create.items.filter((it) => "children" in it).map((it) => [it.label, leavesOf(it).map((t) => t.action)]),
    );
    expect(families["Rectangle"]).toEqual(["rectangle", "centerRectangle", "rectangle3"]);
    expect(families["Circle"]).toEqual(["circle", "circle2", "circle3"]);
    // The first child is what the button does before anyone has held it, so the
    // plainest member of each family has to lead.
    expect(create.items.filter((it) => "children" in it)).toHaveLength(2);
  });

  it("keeps the shortcut key with the tool it belongs to, not with the family", () => {
    // R and C are the keys for the plain rectangle and the plain circle. Folding
    // moved those tools into `children`, and a key left behind on the wrapper
    // would arm nothing: the keymap resolves actions, and a family has none.
    const create = SKETCH.find((g) => g.label === "CREATE")!;
    const byAction = new Map(create.items.flatMap(leavesOf).map((t) => [t.action, t]));
    expect(byAction.get("rectangle")?.key).toBe("R");
    expect(byAction.get("circle")?.key).toBe("C");
  });
});
