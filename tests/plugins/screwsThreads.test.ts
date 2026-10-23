// Standard threads for the core `thread` feature: the nearest size to a round
// face, and the profile each family sweeps.

import { describe, expect, it } from "vitest";
import {
  PRINT_CLEARANCE,
  formatOffBy,
  nearestThread,
  threadChoices,
  threadFeature,
  threadProfile,
  trapezoidalAc,
} from "../../plugins/FundaCAD.Screws/threadSpec";

describe("nearest thread size", () => {
  it("reads a 5.0 bore as an M6 tap drill, not as an M5", () => {
    const n = nearestThread(5.0, false)!;
    expect(n.choice.designation).toBe("M6");
    expect(n.choice.pitch).toBe(1);
    expect(n.faceIs).toBe("tap");
    expect(n.offBy).toBe(0);
  });

  it("reads a 6.0 bore as an M6 drawn at nominal", () => {
    const n = nearestThread(6.0, false)!;
    expect(n.choice.designation).toBe("M6");
    expect(n.faceIs).toBe("nominal");
  });

  it("reads a 6.35 shaft as 1/4-20 UNC", () => {
    const n = nearestThread(6.35, true)!;
    expect(n.choice.designation).toBe("1/4-20 UNC");
    expect(n.choice.pitch).toBeCloseTo(1.27, 6);
    expect(n.offBy).toBe(0);
  });

  it("says how far a 5.98 shaft is from M6", () => {
    const n = nearestThread(5.98, true)!;
    expect(n.choice.designation).toBe("M6");
    expect(n.offBy).toBeCloseTo(-0.02, 6);
    expect(formatOffBy(n)).toBe("M6, 0.02 mm under nominal");
  });

  it("covers ISO coarse and fine, UNC, UNF, trapezoidal and ACME", () => {
    const systems = new Set(threadChoices().map((c) => c.system));
    expect([...systems].sort()).toEqual(["acme", "iso", "tr", "unc", "unf"]);
    expect(threadChoices().some((c) => c.designation === "M8x1" && c.fine)).toBe(true);
    expect(threadChoices().some((c) => c.designation === "Tr8x2")).toBe(true);
    expect(nearestThread(8, true, ["tr"])!.choice.designation).toBe("Tr8x1.5");
  });
});

describe("thread profiles", () => {
  const width = (p: [number, number][]) => Math.max(...p.map((q) => q[1])) - Math.min(...p.map((q) => q[1]));
  const depth = (p: [number, number][]) => Math.max(...p.map((q) => Math.abs(q[0])));

  it("cuts ISO external grooves 17H/24 deep and internal ones 5H/8", () => {
    const ext = threadProfile("iso", 1, true, "nominal");
    expect(ext.operation).toBe("cut");
    expect(depth(ext.profile)).toBeCloseTo(0.61343, 4);
    const int = threadProfile("iso", 1, false, "tap");
    expect(int.operation).toBe("cut");
    expect(Math.max(...int.profile.map((q) => q[0]))).toBeCloseTo(0.54127, 4);
  });

  it("joins the internal tooth into a bore drawn at nominal, reaching the ISO minor", () => {
    const t = threadProfile("iso", 1, false, "nominal");
    expect(t.operation).toBe("join");
    expect(3 + Math.min(...t.profile.map((q) => q[0]))).toBeCloseTo(2.45873, 4);
  });

  it("keeps every family's profile narrower than its pitch", () => {
    for (const c of threadChoices()) {
      for (const [external, faceIs] of [
        [true, "nominal"],
        [false, "tap"],
        [false, "nominal"],
      ] as const) {
        expect(width(threadProfile(c.system, c.pitch, external, faceIs).profile)).toBeLessThan(c.pitch);
      }
    }
  });

  it("makes trapezoidal grooves P/2 + ac deep", () => {
    expect(trapezoidalAc(1.5)).toBe(0.15);
    expect(trapezoidalAc(4)).toBe(0.25);
    expect(trapezoidalAc(8)).toBe(0.5);
    expect(depth(threadProfile("tr", 4, true, "nominal").profile)).toBeCloseTo(2.25, 5);
  });
});

describe("the thread feature", () => {
  it("writes a left hand two start Tr8x8 with a print clearance and keeps the choice", () => {
    const choice = threadChoices().find((c) => c.designation === "Tr8x2")!;
    const face = { kind: "face", by: "nearest", point: [4, 0, 0], body: "body1" };
    const f = threadFeature({
      id: "th",
      face,
      choice,
      faceIs: "nominal",
      external: true,
      starts: 4,
      hand: "left",
      clearance: PRINT_CLEARANCE,
    });
    expect(f).toMatchObject({ type: "thread", pitch: 2, starts: 4, hand: "left", operation: "cut", clearance: 0.2 });
    expect(f.spec).toMatchObject({ system: "tr", size: "Tr8", designation: "Tr8x2" });
  });
});

import {
  choicesFor,
  draftForFace,
  draftForFeature,
  featureOf,
  nearestIn,
  offByText,
} from "../../plugins/FundaCAD.Screws/threadTool";

describe("standard thread panel draft", () => {
  const face = { kind: "face", by: "nearest", point: [2.5, 0, 0], body: "body1" } as never;

  it("names every size of a system once, so the size list can key on it", () => {
    for (const s of ["iso", "unc", "unf", "tr", "acme"] as const) {
      const names = choicesFor(s).map((c) => c.designation);
      expect(names.length).toBeGreaterThan(0);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("opens a 5.1 bore on M6 tap drill and says how far off it is", () => {
    const d = draftForFace(face, 5.1, false)!;
    expect(d.designation).toBe("M6");
    expect(d.faceIs).toBe("tap");
    expect(offByText(d)).toBe("M6, 0.10 mm over tap drill");
  });

  it("switching system lands on that system's nearest size", () => {
    const d = draftForFace(face, 6.35, true)!;
    expect(nearestIn(d, "unf")!.choice.designation).toBe("1/4-28 UNF");
  });

  it("writes hand, starts and the print clearance, and reopens on them", () => {
    const d = {
      ...draftForFace(face, 8, true)!,
      system: "tr" as const,
      designation: "Tr8x2",
      hand: "left" as const,
      starts: 4,
      printFit: true,
      clearance: 0.3,
    };
    const f = featureOf(d, "f9") as unknown as Record<string, unknown>;
    expect(f).toMatchObject({ type: "thread", pitch: 2, starts: 4, hand: "left", clearance: 0.3, operation: "cut" });
    const back = draftForFeature(f, null)!;
    expect(back).toMatchObject({
      editing: "f9",
      system: "tr",
      designation: "Tr8x2",
      hand: "left",
      starts: 4,
      printFit: true,
      clearance: 0.3,
    });
  });

  it("leaves the clearance off without Print fit, and a nominal bore joins", () => {
    const d = { ...draftForFace(face, 6, false)!, faceIs: "nominal" as const };
    const f = featureOf(d, "f1") as unknown as Record<string, unknown>;
    expect(f.clearance).toBeUndefined();
    expect(f.operation).toBe("join");
  });
});
