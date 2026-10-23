import { describe, expect, it } from "vitest";
import { alongPolyline, planesMeet } from "../../src/features/planeMath";
import { edgeMatchSelectorFrom } from "../../src/viewport/edgeMatch";
import { featureNumFields } from "../../src/document/numFields";
import type { Vec3 } from "../../src/types";

describe("datum references", () => {
  it("a straight edge pick becomes a fingerprint the engine can follow", () => {
    const sel = edgeMatchSelectorFrom({
      points: [
        [20, 10, 10],
        [20, -10, 10],
      ],
      body: "body1",
    });
    expect(sel).toEqual({
      kind: "edge",
      by: "match",
      body: "body1",
      fp: { mid: [20, 0, 10], dir: [0, 1, 0], length: 20, curve: "line" },
    });
  });

  it("a curved edge keeps the tangent at its middle and no line kind", () => {
    const arc: Vec3[] = [
      [1, 0, 0],
      [Math.SQRT1_2, Math.SQRT1_2, 0],
      [0, 1, 0],
    ];
    const sel = edgeMatchSelectorFrom({ points: arc });
    expect(sel?.fp.curve).toBeUndefined();
    expect(sel?.body).toBeUndefined();
    expect(sel!.fp.length).toBeCloseTo(2 * Math.hypot(1 - Math.SQRT1_2, Math.SQRT1_2), 9);
  });

  it("finds the point and tangent at a fraction of a polyline", () => {
    const at = alongPolyline(
      [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
      ],
      0.75,
    );
    expect(at?.p).toEqual([10, 5, 0]);
    expect(at?.tangent).toEqual([0, 1, 0]);
  });

  it("finds the line two planes meet in", () => {
    const line = planesMeet(
      { origin: [20, 0, 0], normal: [1, 0, 0], xdir: [0, 1, 0] },
      { origin: [0, 0, 10], normal: [0, 0, 1], xdir: [1, 0, 0] },
    );
    expect(line?.origin.map((c) => Math.round(c * 1e9) / 1e9)).toEqual([20, 0, 10]);
    expect(Math.abs(line!.dir[1])).toBeCloseTo(1, 12);
    expect(
      planesMeet(
        { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
        { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] },
      ),
    ).toBeNull();
  });

  it("shows Position and Angle only on the plane forms that have them", () => {
    const plain = featureNumFields("datumPlane", { offset: 0 }).map(([f]) => f);
    expect(plain).not.toContain("t");
    const normal = featureNumFields("datumPlane", { t: 0.5 }).map(([f]) => f);
    expect(normal).toContain("t");
    expect(normal).not.toContain("angle");
    expect(featureNumFields("datumPlane", { angle: 45 }).map(([f]) => f)).toContain("angle");
  });
});
