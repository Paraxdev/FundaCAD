import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { insetsFrom } from "../../../src/app/fitInsets";
import { FIT_MARGIN, HOME_EYE, frameBox, lookQuat } from "../../../src/viewport/navigator/navigator";
import {
  makePose,
  project,
  setOrientation,
  usableInsets,
  type Insets,
  type Pose,
} from "../../../src/viewport/navigator/pose";

const V = { width: 1200, height: 700 };
const INS: Insets = { left: 300, right: 150, top: 40, bottom: 0 };
const BOX = new THREE.Box3(new THREE.Vector3(13, -22, 5), new THREE.Vector3(61, 9, 38));

function posed(ortho: boolean): Pose {
  const p = makePose();
  p.ortho = ortho;
  setOrientation(p, lookQuat(HOME_EYE.clone(), new THREE.Vector3()));
  return p;
}

function silhouette(p: Pose) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < 8; i++) {
    const c = new THREE.Vector3(
      i & 1 ? BOX.max.x : BOX.min.x,
      i & 2 ? BOX.max.y : BOX.min.y,
      i & 4 ? BOX.max.z : BOX.min.z,
    );
    const s = project(p, V, c);
    xs.push(s.x);
    ys.push(s.y);
  }
  return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys) };
}

describe("frameBox with insets", () => {
  for (const ortho of [false, true]) {
    const kind = ortho ? "orthographic" : "perspective";

    it(`${kind}: the box is centred in the free rect and touches its margin on the tight axis`, () => {
      const p = posed(ortho);
      expect(frameBox(p, V, BOX, FIT_MARGIN, INS)).toBe(true);
      const s = silhouette(p);
      const freeL = INS.left;
      const freeR = V.width - INS.right;
      const freeT = INS.top;
      const freeB = V.height - INS.bottom;
      const gapX: [number, number] = [s.l - freeL, freeR - s.r];
      const gapY: [number, number] = [s.t - freeT, freeB - s.b];
      const w = freeR - freeL;
      const h = freeB - freeT;
      expect(s.l - freeL).toBeGreaterThanOrEqual(w * FIT_MARGIN - 0.5);
      expect(s.t - freeT).toBeGreaterThanOrEqual(h * FIT_MARGIN - 0.5);
      const tight = Math.min(gapX[0] / w, gapX[1] / w, gapY[0] / h, gapY[1] / h);
      expect(tight).toBeGreaterThanOrEqual(FIT_MARGIN - 0.01);
      expect(tight).toBeLessThan(FIT_MARGIN + 0.06);
      // Perspective skews the silhouette off the projected centre, so the check is of the centre itself.
      const c = project(p, V, BOX.getCenter(new THREE.Vector3()));
      expect(c.x).toBeCloseTo((freeL + freeR) / 2, 6);
      expect(c.y).toBeCloseTo((freeT + freeB) / 2, 6);
      expect(Math.abs(gapX[0] - gapX[1])).toBeLessThan(w * 0.1);
      expect(Math.abs(gapY[0] - gapY[1])).toBeLessThan(h * 0.1);
    });

    it(`${kind}: an empty free rect frames the whole canvas like no insets`, () => {
      const a = posed(ortho);
      const b = posed(ortho);
      frameBox(a, V, BOX, FIT_MARGIN, { left: 700, right: 500, top: 0, bottom: 0 });
      frameBox(b, V, BOX, FIT_MARGIN);
      expect(a.scale).toBeCloseTo(b.scale, 9);
      expect(a.target.toArray()).toEqual(b.target.toArray());
    });

    it(`${kind}: symmetric insets keep the target on the model centre`, () => {
      const p = posed(ortho);
      frameBox(p, V, BOX, FIT_MARGIN, { left: 200, right: 200, top: 0, bottom: 0 });
      const c = BOX.getCenter(new THREE.Vector3());
      expect(p.target.distanceTo(c)).toBeLessThan(1e-9);
    });

    it(`${kind}: a free rect narrower than the canvas zooms out`, () => {
      const wide = posed(ortho);
      const narrow = posed(ortho);
      frameBox(wide, V, BOX);
      frameBox(narrow, V, BOX, FIT_MARGIN, { left: 500, right: 100, top: 0, bottom: 0 });
      expect(narrow.scale).toBeGreaterThan(wide.scale);
    });
  }
});

describe("usableInsets", () => {
  it("keeps a rect with area and drops one without, exactly at the boundary", () => {
    expect(usableInsets(V, { left: 600, right: 599, top: 0, bottom: 0 })).toEqual({
      left: 600,
      right: 599,
      top: 0,
      bottom: 0,
    });
    expect(usableInsets(V, { left: 600, right: 600, top: 0, bottom: 0 })).toEqual({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    expect(usableInsets(V, { left: 10, right: 0, top: 350, bottom: 350 })).toEqual({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    expect(usableInsets(V, { left: NaN, right: 0, top: 0, bottom: 0 })).toEqual({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
  });
});

describe("insetsFrom", () => {
  const canvas = { left: 20, right: 1220 };
  it("is the reach of the left cards and of the right column into the canvas", () => {
    const left = [
      { left: 30, right: 250 },
      { left: 30, right: 310 },
    ];
    const right = [
      { left: 1000, right: 1210 },
      { left: 1080, right: 1210 },
    ];
    expect(insetsFrom(canvas, left, right)).toEqual({ left: 290, right: 220, top: 0, bottom: 0 });
  });
  it("is zero with no cards, and ignores a card beyond the canvas edge", () => {
    expect(insetsFrom(canvas, [], [])).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(insetsFrom(canvas, [{ left: -50, right: 5 }], [{ left: 1300, right: 1400 }])).toEqual({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
  });
});
