import { describe, expect, it } from "vitest";
import {
  choiceFieldsFor,
  datumChoiceIsNoOp,
  datumChoiceRow,
  datumChoices,
  fieldApplies,
  fieldLabel,
  PICKED_POINT,
  toggleFieldsFor,
} from "../../src/document/optionFields";
import type { Feature } from "../../src/types";

describe("fillet and chamfer option rows", () => {
  it("offers size type, continuity and tangent edges on a fillet", () => {
    expect(choiceFieldsFor("fillet").map((c) => c.field)).toEqual(["sizeType", "continuity"]);
    expect(toggleFieldsFor("fillet").map((t) => t.field)).toEqual(["tangentEdges"]);
  });

  it("shows the second chamfer distance only for a two-distance chamfer", () => {
    expect(fieldApplies("chamfer", "distance2", {})).toBe(false);
    expect(fieldApplies("chamfer", "distance2", { chamferType: "twoDistance" })).toBe(true);
  });

  it("hides the conic profile on a G2 fillet, which ignores it", () => {
    expect(fieldApplies("fillet", "profile", { continuity: "G1" })).toBe(true);
    expect(fieldApplies("fillet", "profile", { continuity: "G2" })).toBe(false);
  });

  it("calls the size a chord length when that is what it is", () => {
    expect(fieldLabel("fillet", "radius", {})).toBeNull();
    expect(fieldLabel("fillet", "radius", { sizeType: "chord" })?.text).toBe("Chord Length");
  });
});

describe("extrude start and end values", () => {
  it("hides the distance up to a target and shows the offset", () => {
    const v = { endType: "upToPlane" };
    expect(fieldApplies("extrude", "distance", v)).toBe(false);
    expect(fieldApplies("extrude", "endOffset", v)).toBe(true);
    expect(fieldApplies("extrude", "upToPlane", v)).toBe(true);
    expect(fieldApplies("extrude", "upToPoint", v)).toBe(false);
  });
  it("keeps symmetric and two sided apart", () => {
    expect(fieldApplies("extrude", "twoSided", { symmetric: true })).toBe(false);
    expect(fieldApplies("extrude", "symmetric", { twoSided: true })).toBe(false);
    expect(fieldApplies("extrude", "distance2", { twoSided: true })).toBe(true);
    expect(fieldApplies("extrude", "distance2", {})).toBe(false);
  });
  it("offers the base planes and every datum plane or point", () => {
    const feats = [
      { id: "dp1", type: "datumPlane", plane: "XY", name: "Lid" },
      { id: "pt1", type: "datumPoint", point: [0, 0, 1] },
    ] as unknown as Feature[];
    expect(datumChoices("upToPlane", feats)?.map((o) => o.value)).toEqual(["XY", "XZ", "YZ", "dp1"]);
    expect(datumChoices("startPoint", feats)?.map((o) => o.label)).toEqual(["pt1"]);
    expect(datumChoices("distance", feats)).toBeNull();
  });

  it("shows the datum plane or point an extrude holds, never a stand in", () => {
    const ex = (v: Record<string, unknown>) => ({ id: "ex", type: "extrude", sketch: "sk", distance: 2, ...v });
    const docOf = (e: Record<string, unknown>) =>
      [
        { id: "dp1", type: "datumPlane", plane: "XY" },
        { id: "pt1", type: "datumPoint", point: [0, 0, 1] },
        e,
        { id: "dp2", type: "datumPlane", plane: "XZ" },
      ] as unknown as Feature[];
    const row = (v: Record<string, unknown>, field: string) => {
      const e = ex(v);
      return datumChoiceRow(e as unknown as Feature, field, docOf(e));
    };
    expect(row({ startType: "plane", startPlane: "dp1" }, "startPlane")?.current).toBe("dp1");
    expect(row({ endType: "upToPoint", upToPoint: "pt1" }, "upToPoint")?.current).toBe("pt1");
    expect(row({ endType: "upToPlane" }, "upToPlane")?.current).toBe("");
    expect(row({ startType: "point" }, "startPoint")?.current).toBe("");
    expect(row({ startType: "plane", startPlane: "dp1" }, "startPlane")?.options.map((o) => o.value)).toEqual([
      "XY",
      "XZ",
      "YZ",
      "dp1",
    ]);
    const picked = row({ endType: "upToPoint", upToPoint: { point: [1, 2, 3], body: "body1" } }, "upToPoint");
    expect(picked?.current).toBe(PICKED_POINT);
    expect(picked?.options.some((o) => o.value === PICKED_POINT)).toBe(true);
    const gone = row({ endType: "upToPlane", upToPlane: "dp9" }, "upToPlane");
    expect(gone?.current).toBe("dp9");
    expect(row({}, "distance")).toBeNull();
    expect(datumChoiceIsNoOp("upToPoint", PICKED_POINT)).toBe(true);
    expect(datumChoiceIsNoOp("startPlane", "")).toBe(true);
    expect(datumChoiceIsNoOp("startPlane", "dp1")).toBe(false);
  });
});
