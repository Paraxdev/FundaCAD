import { describe, expect, it } from "vitest";
import {
  calibrate,
  heightOf,
  imageToPlane,
  moved,
  onImage,
  planeToImage,
  withWidth,
  type Placement,
} from "../../plugins/FundaCAD.ReferenceImages/calibrate";

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);

describe("reference image calibration", () => {
  it("scales about the first point so the second ends up at the typed distance", () => {
    const p: Placement = { at: [10, 5], width: 50, px: [400, 200], angle: 30, flipX: true };
    const a = imageToPlane(p, [0.2, 0.3]);
    const b = imageToPlane(p, [0.9, 0.6]);
    const q = calibrate(p, a, b, 100)!;
    const a2 = imageToPlane(q, [0.2, 0.3]);
    expect(a2[0]).toBeCloseTo(a[0], 9);
    expect(a2[1]).toBeCloseTo(a[1], 9);
    expect(dist(a2, imageToPlane(q, [0.9, 0.6]))).toBeCloseTo(100, 9);
    expect(q.angle).toBe(30);
    expect(q.flipX).toBe(true);
    expect(q.width / p.width).toBeCloseTo(100 / dist(a, b), 12);
  });

  it("gives exact numbers for an axis aligned image", () => {
    const p: Placement = { at: [0, 0], width: 40, px: [400, 200], angle: 0 };
    expect(imageToPlane(p, [0, 0.5])).toEqual([-20, 0]);
    expect(imageToPlane(p, [1, 0.5])).toEqual([20, 0]);
    const q = calibrate(p, [-20, 0], [20, 0], 100)!;
    expect(q.width).toBe(100);
    expect(q.at).toEqual([30, 0]);
    expect(heightOf(q)).toBe(50);
  });

  it("maps plane points back to the image for rotated and flipped placements", () => {
    for (const p of [
      { at: [3, -4], width: 80, px: [300, 400], angle: 0 },
      { at: [3, -4], width: 80, px: [300, 400], angle: 135, flipY: true },
      { at: [-7, 2], width: 12, px: [1000, 10], angle: -20, flipX: true, flipY: true },
    ] as Placement[]) {
      for (const uv of [
        [0, 0],
        [1, 1],
        [0.25, 0.8],
      ] as const) {
        const back = planeToImage(p, imageToPlane(p, uv));
        expect(back[0]).toBeCloseTo(uv[0], 9);
        expect(back[1]).toBeCloseTo(uv[1], 9);
      }
    }
  });

  it("puts the top left pixel at the top left of an unturned image", () => {
    const p: Placement = { at: [0, 0], width: 40, px: [400, 200], angle: 0 };
    expect(imageToPlane(p, [0, 0])).toEqual([-20, 10]);
    expect(imageToPlane({ ...p, flipX: true }, [0, 0])).toEqual([20, 10]);
    expect(onImage(p, [19, -9])).toBe(true);
    expect(onImage(p, [21, 0])).toBe(false);
  });

  it("refuses what is not a calibration or a width", () => {
    const p: Placement = { at: [0, 0], width: 40, px: [400, 200], angle: 0 };
    expect(calibrate(p, [1, 1], [1, 1], 100)).toBeNull();
    for (const d of [0, -5, NaN, Infinity]) expect(calibrate(p, [0, 0], [1, 0], d)).toBeNull();
    expect(withWidth(p, 0)).toBeNull();
    expect(withWidth(p, -1)).toBeNull();
    expect(withWidth(p, 60)!.width).toBe(60);
    expect(withWidth(p, 60)!.at).toEqual([0, 0]);
    expect(moved(p, [2, -3]).at).toEqual([2, -3]);
  });
});
