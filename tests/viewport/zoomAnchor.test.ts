// Does the point under the cursor stay under the cursor?
//
// This is the whole claim of zoom-to-cursor, and it is a claim about PIXELS, so
// it is tested in pixels: put a point at a known place on screen, zoom a dozen
// notches, and project it again after each one. A single notch hides the defect
// this replaced — the drift is a few percent per notch and compounds — which is
// why every case here zooms far enough to matter.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { anchorDolly } from "../../src/viewport/zoomAnchor";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const MIN = 0.5;

/** Where a world point lands in normalised device coordinates, which is the
 *  only thing the user can actually see. */
function ndc(cam: THREE.Vector3, target: THREE.Vector3, p: THREE.Vector3) {
  const c = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 10000);
  c.up.set(0, 0, 1); // the app is Z-up
  c.position.copy(cam);
  c.lookAt(target);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return p.clone().project(c);
}

/** Zoom `n` notches toward `pivot`, reporting where the pivot ends up. */
function sweep(
  cam: THREE.Vector3,
  target: THREE.Vector3,
  pivot: THREE.Vector3,
  factor: number,
  n: number,
) {
  let c = cam.clone();
  let t = target.clone();
  const track = [ndc(c, t, pivot)];
  for (let i = 0; i < n; i++) {
    const next = anchorDolly(c, t, pivot, factor, MIN);
    if (!next) break;
    c = next.position;
    t = next.target;
    track.push(ndc(c, t, pivot));
  }
  return { cam: c, target: t, track };
}

describe("anchorDolly", () => {
  // Deliberately off-centre and off-axis: the projection-onto-the-view-axis form
  // this replaced is EXACT for a pivot already on the axis, so a centred cursor
  // cannot tell the two apart.
  const cam = v(120, -90, 70);
  const target = v(0, 0, 0);
  const pivot = v(10, 45, 20); // NDC (0.33, 0.36): well off centre in both axes

  it("holds the cursor point on its pixel through a long zoom in", () => {
    const { track } = sweep(cam, target, pivot, 0.85, 12);
    const start = track[0]!;
    for (const [i, p] of track.entries()) {
      expect(
        Math.hypot(p.x - start.x, p.y - start.y),
        `notch ${i}: the point under the cursor moved to (${p.x.toFixed(3)}, ${p.y.toFixed(3)}) from (${start.x.toFixed(3)}, ${start.y.toFixed(3)})`,
      ).toBeLessThan(1e-6);
    }
    // and it really was off-centre, or the case proves nothing
    expect(Math.hypot(start.x, start.y)).toBeGreaterThan(0.15);
  });

  it("holds it zooming out too", () => {
    const { track } = sweep(cam, target, pivot, 1 / 0.85, 12);
    const start = track[0]!;
    for (const p of track) {
      expect(Math.hypot(p.x - start.x, p.y - start.y)).toBeLessThan(1e-6);
    }
  });

  it("never re-angles the view, whatever the anchor", () => {
    // The claim that justifies anchoring off-axis at all: the camera-to-target
    // offset is scaled, never rotated. Checked against the direction the camera
    // is actually looking, not against the formula it came from.
    const before = target.clone().sub(cam).normalize();
    const { cam: c, target: t } = sweep(cam, target, pivot, 0.85, 12);
    const after = t.clone().sub(c).normalize();
    expect(after.angleTo(before)).toBeLessThan(1e-9);
  });

  it("refuses to cross the near plane, and says so by returning nothing", () => {
    // Straight at a surface half a millimetre away.
    const close = v(0, 0, MIN);
    expect(anchorDolly(close, v(0, 0, 0), v(0, 0, 0), 0.5, MIN)).toBeNull();

    // One notch from the limit lands ON it rather than overshooting.
    const near = anchorDolly(v(0, 0, MIN * 1.2), v(0, 0, 0), v(0, 0, 0), 0.1, MIN);
    expect(near).not.toBeNull();
    expect(near!.position.distanceTo(near!.target)).toBeCloseTo(MIN, 12);
  });

  it("still zooms OUT when the cursor sits inside the near limit", () => {
    // The gate that makes the clamp apply to zoom-in only. A cursor resting on a
    // near face routinely puts the anchor closer than minDist; clamping that
    // unconditionally refuses the way back out and there is no gesture that
    // recovers it.
    const c = v(0, 0, 40);
    const t = v(0, 0, 0);
    const onNearFace = v(0, 0, 40 - MIN / 2); // a hair in front of the camera
    const out = anchorDolly(c, t, onNearFace, 1.3, MIN);
    expect(out, "zooming out was refused because the cursor was too close").not.toBeNull();
    expect(out!.position.distanceTo(out!.target)).toBeGreaterThan(c.distanceTo(t));
  });

  it("falls back to the orbit target when the cursor point is behind the camera", () => {
    // A raycast that missed everything can report a degenerate point. Zooming
    // toward something behind the camera would fling the view around.
    const behind = v(0, 0, 200);
    const out = anchorDolly(v(0, 0, 100), v(0, 0, 0), behind, 0.8, MIN);
    expect(out).not.toBeNull();
    expect(out!.target.distanceTo(v(0, 0, 0))).toBeLessThan(1e-9);
    expect(out!.position.z).toBeCloseTo(80, 9);
  });
});
