// Projected geometry is dashed in screen pixels (a world fallback without a scale), construction keeps its world
// dashes, and an open loose end is a ring while an untied one stays a dot.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { SketchOverlay, curveObjects } from "../../src/sketch/overlay";
import { SketchPlane } from "../../src/sketch/plane";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { LooseEnds } from "../../src/sketch/looseEnds";

const plane = new SketchPlane("XY");
const SRC = { kind: "sketchCurve", sketch: "s0", entity: "e0" } as const;
const projected: ResolvedEntity = {
  type: "projected",
  id: "p1",
  source: SRC,
  curve: { kind: "line", x1: 3.5, y1: -2, x2: 29, y2: 11.25 },
};
const stale: ResolvedEntity = { ...projected, id: "p2", stale: true };
const circle: ResolvedEntity = {
  type: "projected",
  id: "p3",
  source: SRC,
  curve: { kind: "circle", x: 7, y: 4, r: 5 },
};
const construction: ResolvedEntity = { type: "line", id: "c1", x1: 3, y1: -2, x2: 9, y2: 6, construction: true };

const lineOf = (o: THREE.Object3D) => ((o as THREE.Group).isGroup ? (o as THREE.Group).children[0] : o) as THREE.Line;
const dashOf = (o: THREE.Object3D) => {
  const m = lineOf(o).material as THREE.LineDashedMaterial;
  return { dashed: m instanceof THREE.LineDashedMaterial, dash: m.dashSize, gap: m.gapSize };
};

describe("projected dashes", () => {
  it("are 14 px with 3 px gaps at the given scale, on a line and a circle", () => {
    const objs = curveObjects([projected, circle], plane, 0x123456, false, 0.37);
    const want = { dashed: true, dash: 14 * 0.37, gap: 3 * 0.37 };
    expect(objs.map(dashOf)).toEqual([want, want]);
  });

  it("fall back to 2.4 mm and 0.5 mm without a usable scale", () => {
    const want = { dashed: true, dash: 2.4, gap: 0.5 };
    for (const scale of [undefined, 0, -1, NaN, Infinity]) {
      expect(curveObjects([projected], plane, 0x123456, false, scale).map(dashOf)).toEqual([want]);
    }
  });

  it("follow a new scale with their own material, one per scale and colour", () => {
    const a = curveObjects([projected], plane, 0x123456, false, 0.2);
    const b = curveObjects([projected], plane, 0x123456, false, 0.9);
    const a2 = curveObjects([stale], plane, 0x123456, false, 0.2);
    expect(dashOf(a[0]!)).toEqual({ dashed: true, dash: 14 * 0.2, gap: 3 * 0.2 });
    expect(dashOf(b[0]!)).toEqual({ dashed: true, dash: 14 * 0.9, gap: 3 * 0.9 });
    expect(lineOf(a[0]!).material).not.toBe(lineOf(b[0]!).material);
    expect(lineOf(a[0]!).material).not.toBe(lineOf(a2[0]!).material);
    expect(lineOf(a[0]!).material).toBe(lineOf(curveObjects([projected], plane, 0x123456, false, 0.2)[0]!).material);
  });

  it("stay correct after many scales have cycled the material cache", () => {
    for (let i = 1; i <= 120; i++) curveObjects([projected], plane, 0x123456, false, i / 100);
    expect(dashOf(curveObjects([projected], plane, 0x123456, false, 0.5)[0]!)).toEqual({
      dashed: true,
      dash: 7,
      gap: 1.5,
    });
  });

  it("dash a stale projection and keep the dash on a highlight pass in the pass colour", () => {
    const [s] = curveObjects([stale], plane, 0x123456, false, 0.4);
    const [h] = curveObjects([stale], plane, 0x33aaff, true, 0.4);
    expect(dashOf(s!)).toEqual({ dashed: true, dash: 14 * 0.4, gap: 3 * 0.4 });
    expect(dashOf(h!)).toEqual(dashOf(s!));
    expect((lineOf(h!).material as THREE.LineDashedMaterial).color.getHex()).toBe(0x33aaff);
  });

  it("have line distances, or three would draw them solid", () => {
    const [o] = curveObjects([projected], plane, 0x123456, false, 0.4);
    const d = lineOf(o!).geometry.getAttribute("lineDistance");
    expect(d.count).toBeGreaterThan(0);
    expect(d.getX(d.count - 1)).toBeGreaterThan(0);
  });

  it("never read like construction: another gap to dash ratio at every scale", () => {
    const [c] = curveObjects([construction], plane, 0x123456, false, 0.4);
    const cd = dashOf(c!);
    expect({ dash: cd.dash, gap: cd.gap }).toEqual({ dash: 1.6, gap: 1 });
    for (const scale of [undefined, 0.05, 0.4, 3]) {
      const p = dashOf(curveObjects([projected], plane, 0x123456, false, scale)[0]!);
      expect(p.gap / p.dash).toBeCloseTo(0.21, 2);
      expect(Math.abs(p.gap / p.dash - cd.gap / cd.dash)).toBeGreaterThan(0.3);
    }
  });
});

const ends: LooseEnds = {
  open: [
    { entity: "a", p: 0, x: 4, y: 5 },
    { entity: "b", p: 1, x: 8, y: -3 },
    { entity: "e", p: 1, x: -6, y: 7.5 },
  ],
  untied: [{ entity: "c", p: 0, x: 12, y: 2, touches: "d", gap: 0.4, tieable: true }],
} as unknown as LooseEnds;
const group = (o: SketchOverlay) => (o as unknown as { looseEndsGroup: THREE.Group }).looseEndsGroup;
const mats = (o: SketchOverlay) => group(o).children.map((c) => (c as THREE.Points).material as THREE.PointsMaterial);
const alphaAt = (m: THREE.PointsMaterial, x: number, y: number) => {
  const img = m.map!.image as { width: number; data: Uint8Array };
  return img.data[(y * img.width + x) * 4 + 3]!;
};

describe("loose end markers", () => {
  it("draw nothing for none, a ring for one open end, a dot for one untied end", () => {
    const o = new SketchOverlay();
    o.setLooseEnds(plane, { open: [], untied: [] } as unknown as LooseEnds);
    expect(group(o).children).toHaveLength(0);
    o.setLooseEnds(plane, { open: [ends.open[0]!], untied: [] } as unknown as LooseEnds);
    expect(mats(o).map((m) => m.size)).toEqual([13]);
    o.setLooseEnds(plane, { open: [], untied: ends.untied } as unknown as LooseEnds);
    expect(mats(o).map((m) => m.size)).toEqual([11]);
  });

  it("use a ring map for open ends and the filled dot map for untied ends, with many ends", () => {
    const o = new SketchOverlay();
    o.setLooseEnds(plane, ends);
    const [open, untied] = mats(o);
    expect(group(o).children.map((c) => (c as THREE.Points).geometry.getAttribute("position").count)).toEqual([3, 1]);
    expect(open!.map).not.toBe(untied!.map);
    expect([open!.size, untied!.size]).toEqual([13, 11]);
  });

  it("have a ring texture with a clear middle and a solid rim, the dot filled in the middle", () => {
    const o = new SketchOverlay();
    o.setLooseEnds(plane, ends);
    const [open, untied] = mats(o);
    expect([alphaAt(open!, 16, 16), alphaAt(open!, 16, 1)]).toEqual([0, 255]);
    expect(alphaAt(untied!, 16, 16)).toBe(255);
  });

  it("share one material per colour and shape", () => {
    const a = new SketchOverlay();
    const b = new SketchOverlay();
    a.setLooseEnds(plane, ends);
    b.setLooseEnds(plane, ends);
    expect(mats(a)).toEqual(mats(b));
    expect(mats(a)[0]).toBe(mats(b)[0]);
  });
});
