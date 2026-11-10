// The Measure readout's markup moved to a component, which left the interesting
// half, which lines appear, in which order, in which unit, as a pure function.
// MeasureTool keeps the picking, the shortest-distance search and the viewport
// marker; none of that is reachable without WebGL, but this is.

import { afterEach, describe, it, expect } from "vitest";
import * as THREE from "three";
import { measureRows, type MeasureProbe } from "../../src/features/measureRows";
import { setLanguage } from "../../src/i18n";
import { setUnit } from "../../src/ui/units";

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

const face = (area: number, at = V(0, 0, 0), dir = V(0, 0, 1)): MeasureProbe => ({
  kind: "face",
  area,
  point: at,
  dir,
});
const edge = (length: number, at = V(0, 0, 0), dir = V(1, 0, 0)): MeasureProbe => ({
  kind: "edge",
  length,
  point: at,
  dir,
});

const keys = (rows: { k: string }[]) => rows.map((r) => r.k);
const valueOf = (rows: { k: string; v: string }[], k: string) => rows.find((r) => r.k === k)?.v;

afterEach(async () => {
  setUnit("mm");
  await setLanguage("system");
});

describe("measureRows", () => {
  it("asks for a pick when nothing has been picked", () => {
    expect(measureRows(undefined, undefined, null)).toEqual([{ k: "", v: "Pick a face or edge" }]);
  });

  it("reports area for one face and length for one edge", () => {
    expect(keys(measureRows(face(50), undefined, null))).toEqual(["Area", "At"]);
    expect(keys(measureRows(edge(50), undefined, null))).toEqual(["Length", "At"]);
  });

  it("squares the unit on an area and not on a length", () => {
    expect(valueOf(measureRows(face(50), undefined, null), "Area")).toBe("50 mm²");
    expect(valueOf(measureRows(edge(50), undefined, null), "Length")).toBe("50 mm");
  });

  it("converts a length linearly and an area quadratically", () => {
    setUnit("cm");
    expect(valueOf(measureRows(edge(50), undefined, null), "Length")).toBe("5 cm");
    // 100 mm² is 1 cm², not 10, the f² is the whole reason A() exists separately
    expect(valueOf(measureRows(face(100), undefined, null), "Area")).toBe("1 cm²");
  });

  it("reports the closest-approach set once two things are picked", () => {
    const a = face(1, V(0, 0, 0), V(0, 0, 1));
    const b = face(1, V(10, 0, 0), V(1, 0, 0));
    const near = { d: 4, pa: V(1, 0, 0), pb: V(5, 0, 0) };
    const rows = measureRows(a, b, near);
    expect(keys(rows)).toEqual(["Distance", "ΔX ΔY ΔZ", "Centers", "Angle"]);
    expect(valueOf(rows, "Distance")).toBe("4 mm");
    // the delta is the closest PAIR's, not the two probe points'
    expect(valueOf(rows, "ΔX ΔY ΔZ")).toBe("4, 0, 0");
    expect(valueOf(rows, "Centers")).toBe("10 mm");
    expect(valueOf(rows, "Angle")).toBe("90°");
  });

  it("does not mutate the closest pair while formatting the delta", () => {
    const near = { d: 4, pa: V(1, 0, 0), pb: V(5, 0, 0) };
    measureRows(face(1), face(1, V(10, 0, 0)), near);
    expect(near.pb.toArray()).toEqual([5, 0, 0]);
  });

  it("falls back to the one-probe readout if a second probe arrives with no pair", () => {
    // defensive: closestPair is only computed when there are two probes, but the
    // signature allows the mismatch and a crash here would kill the whole tool
    expect(keys(measureRows(face(50), face(20), null))).toEqual(["Area", "At"]);
  });
});

describe("measureRows in a comma language", () => {
  const a = face(12.375, V(12.5, -3.25, 40), V(0, 0, 1));
  const b = edge(50, V(3, 4, 5), V(1, 1, 0));
  const near = { d: 2.5, pa: V(1, 2, 3), pb: V(1.5, -0.35, 8) };

  it("reads one pick with a decimal comma and joins the position with semicolons", async () => {
    await setLanguage("de");
    expect(measureRows(a, undefined, null)).toEqual([
      { k: "Area", v: "12,375 mm²" },
      { k: "At", v: "12,5; -3,25; 40" },
    ]);
  });

  it("keeps the point and the comma joined list in English", () => {
    expect(measureRows(a, undefined, null)).toEqual([
      { k: "Area", v: "12.375 mm²" },
      { k: "At", v: "12.5, -3.25, 40" },
    ]);
  });

  it("reads a pair with a decimal comma in inches", async () => {
    await setLanguage("fr");
    setUnit("in");
    expect(measureRows(a, b, near)).toEqual([
      { k: "Distance", v: "0,0984 in" },
      { k: "ΔX ΔY ΔZ", v: "0,0197; -0,0925; 0,197" },
      { k: "Centers", v: "1,46 in" },
      { k: "Angle", v: "90°" },
    ]);
  });
});
