import { describe, expect, it } from "vitest";
import { interferenceData, interferenceSummary, interferenceTitle } from "../../src/ui/interferenceRows";

const pair = (a: string, b: string, aName: string, bName: string, volume: number) => ({
  a,
  b,
  aName,
  bName,
  volume,
});
const near = (a: string, b: string, aName: string, bName: string, distance: number) => ({
  a,
  b,
  aName,
  bName,
  distance,
});

const mm = {
  unit: "mm",
  scale: 1,
  round: (n: number) => Math.round(n * 100) / 100,
  label: (id: string, raw: string) => ({ body3: "Box 2", body7: "Lid" })[id] ?? raw,
};
const GLYPHS = /[∩↔]/;

describe("interferenceData", () => {
  it("has no rows for no pairs", () => {
    const d = interferenceData({ pairs: [], clearances: [], unchecked: [] }, mm);
    expect(d).toEqual({ title: "Interference", clashes: [], clearances: [], unchecked: [] });
  });

  it("names one clash and one close pair in words, with no glyphs", () => {
    const d = interferenceData(
      {
        pairs: [pair("body3", "body7", "Box", "Lid", 2.5)],
        clearances: [near("body7", "body9", "Lid", "Pin", 0.234)],
        unchecked: [],
      },
      mm,
    );
    expect(d.title).toBe("Interference, 1 clash");
    expect(d.clashes).toEqual([
      {
        key: "body3 body7",
        label: "Box 2 and Lid",
        v: "2.5 mm³ overlap",
        spoken: "Box 2 and Lid, overlap 2.5 mm³",
        a: "body3",
        b: "body7",
      },
    ]);
    expect(d.clearances).toEqual([
      {
        key: "body7 body9",
        label: "Lid and Pin",
        v: "0.23 mm apart",
        spoken: "Lid and Pin, 0.23 mm apart",
        a: "body7",
        b: "body9",
      },
    ]);
    for (const r of [...d.clashes, ...d.clearances]) {
      expect(r.label + r.spoken).not.toMatch(GLYPHS);
    }
  });

  it("keeps three clashes in engine order with distinct keys and a plural title", () => {
    const d = interferenceData(
      {
        pairs: [
          pair("body1", "body2", "A", "B", 7.1),
          pair("body2", "body3", "B", "C", 0.4),
          pair("body1", "body3", "A", "C", 12.75),
        ],
        clearances: [],
        unchecked: [{ id: "body9", name: "Rod", reason: "is open" }],
      },
      mm,
    );
    expect(d.title).toBe("Interference, 3 clashes");
    expect(d.clashes.map((r) => [r.key, r.label, r.v])).toEqual([
      ["body1 body2", "A and B", "7.1 mm³ overlap"],
      ["body2 body3", "B and Box 2", "0.4 mm³ overlap"],
      ["body1 body3", "A and Box 2", "12.75 mm³ overlap"],
    ]);
    expect(new Set(d.clashes.map((r) => r.key)).size).toBe(3);
    expect(d.unchecked).toEqual(["Rod is open"]);
  });

  it("shows the volume and distance in the display unit", () => {
    const inch = { ...mm, unit: "in", scale: 1 / 25.4 };
    const d = interferenceData(
      {
        pairs: [pair("body1", "body2", "A", "B", 25.4 ** 3 * 2)],
        clearances: [near("body1", "body2", "A", "B", 12.7)],
        unchecked: [],
      },
      inch,
    );
    expect(d.clashes[0]!.v).toBe("2 in³ overlap");
    expect(d.clashes[0]!.spoken).toBe("A and B, overlap 2 in³");
    expect(d.clearances[0]!.v).toBe("0.5 in apart");
    expect(d.clearances[0]!.spoken).toBe("A and B, 0.5 in apart");
  });
});

describe("interferenceTitle", () => {
  it("is plain for 0 and singular for 1", () => {
    expect([0, 1, 2, 11].map(interferenceTitle)).toEqual([
      "Interference",
      "Interference, 1 clash",
      "Interference, 2 clashes",
      "Interference, 11 clashes",
    ]);
  });
});

describe("interferenceSummary", () => {
  it("says no clashes for an empty check, and does not mention close pairs outside Clearance mode", () => {
    expect(interferenceSummary(0, null, 0)).toBe("Interference: no clashes");
  });

  it("counts one clash in the singular", () => {
    expect(interferenceSummary(1, null, 0)).toBe("Interference: 1 clash");
  });

  it("counts clashes, close pairs and unchecked bodies together", () => {
    expect(interferenceSummary(3, 2, 1)).toBe("Interference: 3 clashes, 2 close pairs, 1 body could not be checked");
    expect(interferenceSummary(7, 1, 4)).toBe("Interference: 7 clashes, 1 close pair, 4 bodies could not be checked");
  });

  it("says no close pairs when Clearance mode found none, which is not the same as not asking", () => {
    expect(interferenceSummary(0, 0, 0)).toBe("Interference: no clashes, no close pairs");
    expect(interferenceSummary(2, 0, 0)).not.toBe(interferenceSummary(2, null, 0));
  });

  it("does not call a check with unchecked bodies clean", () => {
    expect(interferenceSummary(0, null, 2)).toBe("Interference: no clashes, 2 bodies could not be checked");
  });
});
