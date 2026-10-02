import { afterEach, describe, expect, it } from "vitest";
import {
  CUSTOM_MATERIAL, STRESS_MATERIALS, buildStressRequest, forceVector, formatStressResult, intoDirection,
  legendGradient, newLoad, newSetup, stressColor, stressColors, valueRange, type StressFaceSet, type StressSetup,
} from "../../src/ui/stress";
import { setUnit } from "../../src/ui/units";
import type { StressReply } from "../../src/geometry/client";
import type { Selector } from "../../src/types";

// The pure half of the Stress panel: what it sends, how it reads the reply,
// and the colours it paints with.

const top: Selector = { kind: "face", by: "nearest", point: [5, 5, 10], body: "b1" };
const bottom: Selector = { kind: "face", by: "nearest", point: [5, 5, 0], body: "b1" };

function faces(sel: Selector, normal: [number, number, number], area = 100, ids = [3]): StressFaceSet {
  return { selectors: [sel], faceIds: ids, normalSum: [normal[0] * area, normal[1] * area, normal[2] * area], area };
}

function ready(): StressSetup {
  const s = newSetup("b1");
  s.supports[0]!.faces = faces(bottom, [0, 0, -1], 100, [1]);
  s.loads[0]!.faces = faces(top, [0, 0, 1]);
  return s;
}

afterEach(() => setUnit("mm"));

describe("stress materials", () => {
  it("mirror the engine's presets by name and value", () => {
    expect(STRESS_MATERIALS.map((m) => [m.name, m.E, m.nu, m.yield])).toEqual([
      ["PLA", 3500, 0.36, 50],
      ["PETG", 2100, 0.38, 50],
      ["ABS", 2200, 0.35, 40],
      ["ASA", 2200, 0.35, 45],
      ["PA12 nylon", 1700, 0.4, 45],
      ["PC", 2400, 0.37, 60],
      ["aluminium 6061-T6", 69000, 0.33, 275],
      ["steel S235", 210000, 0.3, 235],
    ]);
  });
});

describe("buildStressRequest", () => {
  it("sends a preset by name, a force into the face, and no size when blank", () => {
    const r = buildStressRequest(ready());
    expect(r).toEqual({
      ok: true,
      body: "b1",
      options: {
        supports: [{ type: "fixed", faces: [bottom] }],
        loads: [{ faces: [top], force: [0, 0, -100] }],
        material: "PLA",
      },
    });
  });

  it("keeps the body stamped on every selector", () => {
    const r = buildStressRequest(ready());
    if (!r.ok) throw new Error(r.message);
    for (const s of [...r.options.supports!.flatMap((x) => x.faces), ...r.options.loads.flatMap((l) => l.faces)]) expect(s.body).toBe("b1");
  });

  it("points a force along an axis or a custom vector, scaled to its magnitude", () => {
    const s = ready();
    const l = s.loads[0]!;
    l.force = 20;
    l.direction = "+X";
    expect(forceVector(l)).toEqual([20, 0, 0]);
    l.direction = "-Y";
    expect(forceVector(l)).toEqual([0, -20, 0]);
    l.direction = "custom";
    l.custom = [3, 0, 4];
    expect(forceVector(l)).toEqual([12, 0, 16]);
    const r = buildStressRequest(s);
    expect(r.ok && r.options.loads[0]).toEqual({ faces: [top], force: [12, 0, 16] });
  });

  it("sends the same bytes for a slanted face whatever the last bit of the normal", () => {
    const s = ready();
    const h = Math.SQRT1_2;
    s.loads[0]!.faces = faces(top, [h, 0, h], 37.5);
    s.loads[0]!.force = 10;
    const r = buildStressRequest(s);
    expect(r.ok && r.options.loads[0]).toEqual({ faces: [top], force: [-7.07106781187, 0, -7.07106781187] });
  });

  it("sends a pressure in MPa as it is", () => {
    const s = ready();
    s.loads[0]!.kind = "pressure";
    s.loads[0]!.pressure = 0.5;
    const r = buildStressRequest(s);
    expect(r.ok && r.options.loads).toEqual([{ faces: [top], pressure: 0.5 }]);
  });

  it("sends a custom material as numbers and the element size in mm whatever the display unit", () => {
    setUnit("in");
    const s = ready();
    s.material = CUSTOM_MATERIAL;
    s.custom = { E: 2300, nu: 0.35, yield: 40, density: 1.1 };
    s.size = 2;
    const r = buildStressRequest(s);
    expect(r.ok && r.options.material).toEqual({ E: 2300, nu: 0.35, yield: 40, density: 1.1, name: "Custom" });
    expect(r.ok && r.options.size).toBe(2);
  });

  it("refuses a cleared custom field, which a number input reads as \"\"", () => {
    const blank = "" as unknown as number;
    for (const k of ["E", "nu", "yield"] as const) {
      const s = ready();
      s.material = CUSTOM_MATERIAL;
      s.custom[k] = blank;
      const r = buildStressRequest(s);
      expect(r.ok, k).toBe(false);
    }
    const s = ready();
    s.size = blank;
    expect(buildStressRequest(s).ok).toBe(false);
  });

  it("says what is missing, in order", () => {
    const msg = (s: StressSetup) => {
      const r = buildStressRequest(s);
      return r.ok ? "ok" : r.message;
    };
    expect(msg(newSetup(null))).toMatch(/body/);
    expect(msg(newSetup("b1"))).toBe("set the faces of the support from a face selection");
    const s = ready();
    s.loads.push(newLoad(2));
    expect(msg(s)).toBe("set the faces of load 2 from a face selection");
    s.loads.pop();
    s.loads[0]!.force = 0;
    expect(msg(s)).toMatch(/needs a force/);
    s.loads[0]!.force = 10;
    s.material = CUSTOM_MATERIAL;
    s.custom.nu = 0.5;
    expect(msg(s)).toMatch(/Poisson/);
    s.custom.nu = 0.3;
    s.size = -1;
    expect(msg(s)).toMatch(/element size/);
    s.loads = [];
    expect(msg(s)).toBe("add a load, or turn on gravity");
  });

  it("refuses \"into the face\" on faces that point every way", () => {
    const s = ready();
    // A whole cylinder: the outward normals cancel.
    s.loads[0]!.faces = { selectors: [top], faceIds: [3], normalSum: [0.1, 0, 0], area: 60 };
    const r = buildStressRequest(s);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/no single direction/);
  });
});

describe("intoDirection", () => {
  it("is minus the mean outward normal", () => {
    expect(intoDirection(faces(top, [0, 0, 1]))).toEqual([0, 0, -1]);
  });
  it("is null with no faces", () => {
    expect(intoDirection({ selectors: [], faceIds: [], normalSum: [0, 0, 0], area: 0 })).toBeNull();
  });
});

const reply: StressReply = {
  body: "b1",
  name: "Bracket",
  material: { name: "PLA", E: 3500, nu: 0.36, yield: 50 },
  mesh: { nodes: 1200, elements: 4800, size: 2.54, minDihedral: 11.2 },
  maxVonMises: { value: 31.25, at: [25.4, 0, 50.8], face: 4 },
  maxDisplacement: { value: 1.27, at: [254, 0, 0], vector: [0, 0, -1.27] },
  safetyFactor: 1.6,
  applied: [0, 0, -20],
  reaction: [0, 0, 20],
  warnings: ["printed parts are weaker across layers"],
  surface: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], vonMises: [2, 31.25, 10] },
  errors: [{ feature_id: "f3", message: "fillet failed" }],
};

describe("formatStressResult", () => {
  it("shows lengths in the user's unit and stresses in MPa", () => {
    setUnit("in");
    const v = formatStressResult(reply, "in");
    const row = (k: string) => v.rows.find((r) => r.k === k)?.v;
    expect(row("Peak von Mises")).toBe("31.25 MPa");
    expect(row("Peak at")).toBe("1, 0, 2 in");
    expect(row("Max deflection")).toBe("0.05 in");
    expect(row("Deflection at")).toBe("10, 0, 0 in");
    expect(row("Safety factor")).toBe("1.6");
    expect(row("Mesh")).toBe("4800 elements, 2.54 mm");
    expect(row("Reaction")).toBe("0, 0, 20 N");
    expect(v.yields).toBe(false);
  });

  it("reads a peak inside the body, with a null face", () => {
    const v = formatStressResult({ ...reply, maxVonMises: { value: 3, at: [0, 0, 0], face: null } }, "mm");
    expect(v.rows.find((r) => r.k === "Peak at")?.v).toBe("0, 0, 0 mm");
  });

  it("collects warnings and feature errors, and takes the legend from the field", () => {
    const v = formatStressResult(reply, "mm");
    expect(v.warnings).toEqual(["printed parts are weaker across layers", "f3: fillet failed"]);
    expect(v.legend).toEqual({ min: 2, max: 31.25 });
  });

  it("flags a part that yields, and reads a null safety factor as nothing stressed", () => {
    expect(formatStressResult({ ...reply, safetyFactor: 0.8 }, "mm").yields).toBe(true);
    const none = formatStressResult({ ...reply, safetyFactor: null }, "mm");
    expect(none.yields).toBe(false);
    expect(none.rows.find((r) => r.k === "Safety factor")?.v).toBe("none, no stress");
  });
});

describe("colour map", () => {
  it("runs blue to red through cyan, green and yellow", () => {
    expect(stressColor(0)).toEqual([0, 0, 1]);
    expect(stressColor(0.25)).toEqual([0, 1, 1]);
    expect(stressColor(0.5)).toEqual([0, 1, 0]);
    expect(stressColor(0.75)).toEqual([1, 1, 0]);
    expect(stressColor(1)).toEqual([1, 0, 0]);
    expect(stressColor(0.125)).toEqual([0, 0.5, 1]);
  });

  it("clamps out-of-range values and reads NaN as the low end", () => {
    expect(stressColor(-3)).toEqual([0, 0, 1]);
    expect(stressColor(7)).toEqual([1, 0, 0]);
    expect(stressColor(NaN)).toEqual([0, 0, 1]);
  });

  it("maps values over a range, three numbers per vertex, and a flat field to blue", () => {
    expect([...stressColors([10, 20, 15], 10, 20)]).toEqual([0, 0, 1, 1, 0, 0, 0, 1, 0]);
    expect([...stressColors([5, 5], 5, 5)]).toEqual([0, 0, 1, 0, 0, 1]);
  });

  it("ranges over finite values only", () => {
    expect(valueRange([3, NaN, -1, 8])).toEqual({ min: -1, max: 8 });
    expect(valueRange([])).toEqual({ min: 0, max: 0 });
  });

  it("draws the legend from the same stops", () => {
    expect(legendGradient()).toBe(
      "linear-gradient(to right, rgb(0, 0, 255) 0%, rgb(0, 255, 255) 25%, rgb(0, 255, 0) 50%, rgb(255, 255, 0) 75%, rgb(255, 0, 0) 100%)",
    );
  });
});
