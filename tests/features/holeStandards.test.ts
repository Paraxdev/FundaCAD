import { describe, expect, it } from "vitest";
import {
  CLEARANCE, COUNTERBORE, COUNTERSINK, HOLE_SIZES, INSERT, TAP_DRILL,
  holeChoicePatch, holeFieldApplies, newHoleFields, parseHoleSize, standardDims,
} from "../../src/features/holeStandards";
import type { Feature } from "../../src/types";
import py from "../../sidecar/hole_feature.py?raw";

type Hole = Extract<Feature, { type: "hole" }>;

const hole = (over: Partial<Hole> = {}): Hole => ({
  id: "h", type: "hole", points: [[0, 0, 10]],
  face: { kind: "face", by: "nearest", point: [0, 0, 10] },
  ...newHoleFields("simple", "M3", "through"),
  ...over,
});

describe("hole standard tables", () => {
  it("hold the ISO values the sidecar holds", () => {
    expect(CLEARANCE.M3).toEqual([3.2, 3.4, 3.6]);
    expect(TAP_DRILL.M5).toBe(4.2);
    expect(COUNTERBORE.M4).toEqual([8.0, 4.4]);
    expect(COUNTERSINK.M6).toBe(13.7);
    expect(INSERT.M3).toEqual([4.0, 6.0]);
  });

  it("match sidecar/hole_feature.py row for row", () => {
    const num = (v: number) => (Number.isInteger(v) ? `${v}.0` : String(v));
    const row = (name: string, size: string, vals: readonly number[]) => {
      const block = new RegExp(`^${name} = \\{([\\s\\S]*?)^\\}`, "m").exec(py)?.[1] ?? "";
      const text = vals.length === 1 ? num(vals[0]!) : `(${vals.map(num).join(", ")})`;
      expect(block, `${name} ${size}`).toContain(`"${size}": ${text}`);
    };
    for (const s of HOLE_SIZES) {
      row("CLEARANCE", s, CLEARANCE[s]);
      row("TAP_DRILL", s, [TAP_DRILL[s]]);
      row("COUNTERBORE", s, COUNTERBORE[s]);
      row("COUNTERSINK", s, [COUNTERSINK[s]]);
      const ins = INSERT[s];
      if (ins) row("INSERT", s, ins);
    }
  });
});

describe("standardDims", () => {
  it("gives a clearance diameter by fit, and head dimensions by type", () => {
    expect(standardDims("simple", "clearance", "M4", "close")).toEqual({ diameter: 4.3 });
    expect(standardDims("counterbore", undefined, "M5", "loose")).toEqual({ diameter: 5.8, cbDiameter: 10, cbDepth: 5.4 });
    expect(standardDims("countersink", "tap", "M3", undefined)).toEqual({ diameter: 2.5, csDiameter: 6.9, csAngle: 90 });
    expect(standardDims("simple", "custom", "M3", "normal")).toEqual({});
  });

  it("sizes a heat-set insert bore, and has no insert past M5", () => {
    expect(standardDims("insert", "clearance", "M3", "normal")).toEqual({ diameter: 4, depth: 6, leadIn: 0.5 });
    expect(standardDims("insert", "clearance", "M8", "normal")).toEqual({ leadIn: 0.5 });
  });
});

describe("newHoleFields", () => {
  it("writes every dimension out", () => {
    expect(newHoleFields("counterbore", "M3", "through")).toEqual({
      holeType: "counterbore", standard: "clearance", size: "M3", fit: "normal", extent: "through",
      diameter: 3.4, depth: 6.8, cbDiameter: 6.5, cbDepth: 3.4,
    });
  });

  it("keeps an insert blind", () => {
    const f = newHoleFields("insert", "M4", "through");
    expect(f.extent).toBe("blind");
    expect([f.diameter, f.depth, f.leadIn]).toEqual([5.6, 9, 0.5]);
  });
});

describe("holeChoicePatch", () => {
  it("re-derives the diameter and head from a new size", () => {
    const h = hole({ ...newHoleFields("counterbore", "M3", "through") });
    expect(holeChoicePatch(h, "size", "M5")).toMatchObject({ size: "M5", diameter: 5.5, cbDiameter: 10, cbDepth: 5.4 });
  });

  it("changes only the diameter for a fit", () => {
    const h = hole({ ...newHoleFields("counterbore", "M3", "through"), cbDiameter: 7 });
    expect(holeChoicePatch(h, "fit", "loose")).toEqual({ fit: "loose", diameter: 3.6 });
  });

  it("leaves a parameter-driven dimension alone", () => {
    const h = hole();
    expect(holeChoicePatch(h, "size", "M4", (k) => k === "diameter")).toEqual({ size: "M4" });
  });

  it("fills a custom hole's new counterbore from its diameter", () => {
    const h = hole({ standard: "custom", diameter: 4 });
    expect(holeChoicePatch(h, "holeType", "counterbore")).toEqual({
      holeType: "counterbore", cbDiameter: 7.6, cbDepth: 4,
    });
  });

  it("turns an insert blind and sizes it", () => {
    const h = hole({ extent: "through" });
    expect(holeChoicePatch(h, "holeType", "insert")).toMatchObject({
      holeType: "insert", extent: "blind", diameter: 4, depth: 6, leadIn: 0.5,
    });
  });

  it("gives a hole going blind a depth only when it has none", () => {
    const { depth: _d, ...noDepth } = hole();
    expect(holeChoicePatch(noDepth as Hole, "extent", "blind")).toEqual({ extent: "blind", depth: 6.8 });
    expect(holeChoicePatch(hole({ depth: 5 }), "extent", "blind")).toEqual({ extent: "blind" });
  });

  it("passes a toggle through untouched", () => {
    expect(holeChoicePatch(hole(), "drillPoint", true)).toEqual({ drillPoint: true });
  });
});

describe("holeFieldApplies", () => {
  it("shows the rows the hole reads", () => {
    const through = { holeType: "counterbore", standard: "clearance", extent: "through" };
    expect(holeFieldApplies("cbDiameter", through)).toBe(true);
    expect(holeFieldApplies("csDiameter", through)).toBe(false);
    expect(holeFieldApplies("depth", through)).toBe(false);
    expect(holeFieldApplies("drillPoint", through)).toBe(false);
    expect(holeFieldApplies("fit", { standard: "tap" })).toBe(false);
    expect(holeFieldApplies("tapped", { standard: "tap" })).toBe(true);
    expect(holeFieldApplies("size", { standard: "custom" })).toBe(false);
    const insert = { holeType: "insert", extent: "through" };
    expect(holeFieldApplies("depth", insert)).toBe(true);
    expect(holeFieldApplies("leadIn", insert)).toBe(true);
    expect(holeFieldApplies("extent", insert)).toBe(false);
    expect(holeFieldApplies("standard", insert)).toBe(false);
  });
});

describe("parseHoleSize", () => {
  it("reads a size name or a diameter", () => {
    expect(parseHoleSize("M3")).toEqual({ size: "M3" });
    expect(parseHoleSize(" m2.5 ")).toEqual({ size: "M2.5" });
    expect(parseHoleSize("3.3")).toEqual({ diameter: 3.3 });
    expect(parseHoleSize(".8")).toEqual({ diameter: 0.8 });
    expect(parseHoleSize("M7")).toBeNull();
    expect(parseHoleSize("0")).toBeNull();
    expect(parseHoleSize("abc")).toBeNull();
  });
});
