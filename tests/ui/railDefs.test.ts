import { describe, expect, it } from "vitest";
import { faceOf, familyOf, modelRail, sketchRail, SKETCH_OFF_RAIL, type RailEntry } from "../../src/ui/railDefs";
import { leavesOf, MODEL, SKETCH } from "../../src/ui/ribbonDefs";

const actions = (entries: RailEntry[]) =>
  entries.flatMap((e) => (e.kind === "tool" ? [e.action] : e.items.map((t) => t.action)));

describe("modelRail", () => {
  it("reaches every model tool, with Sketch on its own at the top", () => {
    const rail = modelRail(MODEL);
    expect(rail[0]).toMatchObject({ kind: "tool", action: "sketch" });
    const all = MODEL.flatMap((g) => g.items.flatMap(leavesOf)).map((t) => t.action);
    expect(new Set(actions(rail))).toEqual(new Set(all));
  });

  it("files a plugin group as a category of its own", () => {
    const rail = modelRail([...MODEL, { label: "PRINT", items: [{ action: "print", label: "Print", iconName: "print" }] }]);
    const last = rail[rail.length - 1]!;
    expect(last).toMatchObject({ kind: "family", label: "Print", style: "category", icon: "print" });
  });
});

describe("sketchRail", () => {
  it("reaches every sketch tool except the ones the gizmo replaced", () => {
    const all = SKETCH.flatMap((g) => g.items.flatMap(leavesOf)).map((t) => t.action);
    const onRail = new Set(actions(sketchRail()));
    expect(all.filter((a) => !onRail.has(a) && !SKETCH_OFF_RAIL.has(a))).toEqual([]);
  });

  it("puts the remembered variant on a family's face", () => {
    const rect = familyOf(sketchRail(), "centerRectangle")!;
    expect(rect.style).toBe("variants");
    expect(faceOf(rect, undefined).action).toBe("rectangle");
    expect(faceOf(rect, "centerRectangle").action).toBe("centerRectangle");
    expect(faceOf(rect, "not-in-family").action).toBe("rectangle");
  });
});
