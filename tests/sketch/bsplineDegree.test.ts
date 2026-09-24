// The degree a control-point spline is built with is min(degree, poles - 1),
// as the engine's kernel::bspline_knots clamps it. Degree 5 on four poles used
// to be stored as 5, built as 3, shown checked as 5 in the menu, and Delete then
// refused with "keeps at least 6 control points" on a four pole curve.

import { describe, expect, it } from "vitest";
import {
  bsplineDegree, bsplineInsertKnot, bsplineMinPoles, bsplinePoint, bsplineRange, type BsplineDef,
} from "../../src/sketch/bspline";
import { degreeChoices, deletePole, insertPole, type BsplineEntity } from "../../src/sketch/bsplineEdit";
import { offsetEntity } from "../../src/sketch/modify";

const four: BsplineEntity = {
  type: "bspline", id: "b",
  poles: [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 25, y: -10 }, { x: 40, y: 15 }],
};
const six: BsplineEntity = { ...four, id: "c", poles: [...four.poles, { x: 50, y: 0 }, { x: 60, y: 12 }] };

function expectSameCurve(a: BsplineDef, b: BsplineDef) {
  const [lo, hi] = bsplineRange(a);
  for (let i = 0; i <= 200; i++) {
    const t = lo + ((hi - lo) * i) / 200;
    const p = bsplinePoint(a, t), q = bsplinePoint(b, t);
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1e-9);
  }
}

describe("the degree a spline is built with", () => {
  it("is what the menu shows checked, not the stored request", () => {
    const stored5 = { ...four, degree: 5 };
    expect(bsplineDegree(stored5)).toBe(3);
    const c = degreeChoices([stored5]);
    expect(c.filter((x) => x.checked).map((x) => x.degree)).toEqual([3]);
  });

  it("disables a degree the pole count cannot carry, saying how many poles it needs", () => {
    const c = degreeChoices([four]);
    expect(c.map((x) => [x.degree, x.disabled])).toEqual([[2, false], [3, false], [5, true]]);
    expect(c.find((x) => x.degree === 5)!.label).toBe("Degree 5, needs 6 control points");
    expect(c.find((x) => x.degree === 3)!.label).toBe("Degree 3");
    expect(degreeChoices([six]).every((x) => !x.disabled)).toBe(true);
    // a mixed selection offers only what every spline carries, and checks nothing
    const mixed = degreeChoices([four, six]);
    expect(mixed.find((x) => x.degree === 5)!.disabled).toBe(true);
    expect(mixed.some((x) => x.checked)).toBe(false);
  });

  it("sets the fewest poles Delete keeps", () => {
    expect(bsplineMinPoles({ ...four, degree: 5 })).toBe(4);
    expect(bsplineMinPoles({ ...six, degree: 5 })).toBe(6);
    const five: BsplineEntity = { ...six, poles: six.poles.slice(0, 5), degree: 2 };
    expect(bsplineMinPoles(five)).toBe(3);
    expect(deletePole(five, 2, [])!.entity.poles).toHaveLength(4);
  });

  it("stays put when a pole is inserted into a curve its pole count lowered", () => {
    for (const def of [{ ...four, degree: 5 }, { ...four, poles: four.poles.slice(0, 3) }]) {
      const was = bsplineDegree(def);
      const [a, b] = bsplineRange(def);
      const next = bsplineInsertKnot(def, a + (b - a) * 0.37)!;
      expect(bsplineDegree(next)).toBe(was);
      expect(next.degree).toBe(was);
      expectSameCurve(def, next);
      const at = bsplinePoint(def, a + (b - a) * 0.6);
      const r = insertPole(def, at, 0.5, [], false)!;
      expect(bsplineDegree(r.entity)).toBe(was);
      expectSameCurve(def, r.entity);
    }
  });

  it("leaves an unclamped curve's stored degree alone on insertion", () => {
    const [a, b] = bsplineRange(six);
    expect(bsplineInsertKnot(six, (a + b) / 2)!.degree).toBeUndefined();
  });

  it("is the degree an offset copy is fitted and stored with", () => {
    const r = offsetEntity([{ ...four, degree: 5 }], 0, 2)!;
    const copy = r.entities.find((e) => e.type === "bspline" && e.id !== "b") as BsplineEntity;
    expect(copy.poles.length).toBeGreaterThan(4);
    expect(copy.degree).toBe(3);
    const plain = offsetEntity([six], 0, 2)!;
    const plainCopy = plain.entities.find((e) => e.type === "bspline" && e.id !== "c") as BsplineEntity;
    expect(plainCopy.degree).toBeUndefined();
  });
});
