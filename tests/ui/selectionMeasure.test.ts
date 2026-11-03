import { describe, expect, it } from "vitest";
import {
  circleDiameter,
  describeSelection,
  polylineLength,
  roundFacePrompt,
  roundSize,
  type Pt3,
} from "../../src/ui/selectionMeasure";
import { setUnit } from "../../src/ui/units";

const circle = (r: number, n = 64, z = 5): Pt3[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [r * Math.cos(a), r * Math.sin(a), z] as Pt3;
  });

describe("selection measure", () => {
  it("sums a polyline's length", () => {
    expect(
      polylineLength([
        [0, 0, 0],
        [3, 4, 0],
        [3, 4, 12],
      ]),
    ).toBe(17);
  });

  it("reads a closed tessellated circle's diameter", () => {
    expect(circleDiameter(circle(20))).toBeCloseTo(40, 1);
  });

  // A rim on a slanted plane off the origin, `n` even steps with a vertex added halfway along each step in `split`.
  const rim = (r: number, n: number, split: number[], squash = 1): Pt3[] => {
    const c = [37.5, -12.25, 8.75];
    const u = [0.6, 0.8, 0];
    const v = [-0.48, 0.36, 0.8];
    const at = (k: number): Pt3 => {
      const a = (k / n) * Math.PI * 2;
      const x = r * Math.cos(a),
        y = r * squash * Math.sin(a);
      return [c[0]! + x * u[0]! + y * v[0]!, c[1]! + x * u[1]! + y * v[1]!, c[2]! + x * u[2]! + y * v[2]!];
    };
    return Array.from({ length: n + 1 }, (_, k) => k).flatMap((k) =>
      split.includes(k - 1) ? [at(k - 0.5), at(k)] : [at(k)],
    );
  };

  it("reads a rim's diameter whatever extra vertices sit where its two halves meet", () => {
    expect(circleDiameter(rim(12.5, 79, []))).toBeCloseTo(25, 2);
    expect(circleDiameter(rim(12.5, 79, [39]))).toBeCloseTo(25, 2);
    expect(circleDiameter(rim(6, 24, [11]))).toBeCloseTo(12, 2);
    expect(circleDiameter(rim(12.5, 79, [37, 38, 39, 40]))).toBeCloseTo(25, 2);
  });

  it("refuses a rim squashed past the tolerance, takes one inside it", () => {
    expect(circleDiameter(rim(12.5, 79, [39], 0.975))).toBeNull();
    expect(circleDiameter(rim(12.5, 79, [39], 0.985))).toBeCloseTo(24.81, 1);
  });

  it("refuses shapes that are not circles", () => {
    const square: Pt3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
      [0, 0, 0],
    ];
    expect(circleDiameter(square)).toBeNull();
    const ellipse = circle(20).map(([x, y, z]) => [x, y * 0.5, z] as Pt3);
    expect(circleDiameter(ellipse)).toBeNull();
    expect(circleDiameter(circle(20).slice(0, 20))).toBeNull();
  });

  it("describes one round edge with its length and diameter", () => {
    const text = describeSelection({ count: 1, noun: "edge", plural: "edges", edges: [circle(10)] });
    expect(text).toMatch(/^1 edge · 62\.\d+ mm · ⌀20 mm$/);
  });

  it("gives several edges their total length and no diameter", () => {
    const line: Pt3[] = [
      [0, 0, 0],
      [10, 0, 0],
    ];
    expect(describeSelection({ count: 2, noun: "edge", plural: "edges", edges: [line, line] })).toBe("2 edges · 20 mm");
  });

  it("follows the display unit, the total and the diameter alike", () => {
    setUnit("cm");
    const text = describeSelection({ count: 1, noun: "edge", plural: "edges", edges: [circle(10)] });
    setUnit("mm");
    expect(text).toMatch(/^1 edge · 6\.\d+ cm · ⌀2 cm$/);
  });

  it("counts faces, and nothing for none", () => {
    expect(describeSelection({ count: 3, noun: "face", plural: "faces" })).toBe("3 faces");
    expect(describeSelection({ count: 1, noun: "face", plural: "faces" })).toBe("1 face");
    expect(describeSelection({ count: 0, noun: "face", plural: "faces" })).toBe("");
  });

  it("gives a round face's size by its radius on a partial arc and a diameter on a full wrap", () => {
    expect(roundSize({ radius: 2, full: false })).toBe("R2 mm");
    expect(roundSize({ radius: 2, full: true })).toBe("⌀4 mm");
  });

  it("prompts a partial arc by its radius and offers removal only on a full wrap", () => {
    const partial = roundFacePrompt({ radius: 2, full: false });
    expect(partial).toContain("(R2 mm)");
    expect(partial).not.toContain("⌀");
    expect(partial).not.toMatch(/remove/);
    const full = roundFacePrompt({ radius: 3.369, full: true });
    expect(full).toContain("(⌀6.74 mm)");
    expect(full).toContain("drag it away to nothing to remove it");
  });
});
