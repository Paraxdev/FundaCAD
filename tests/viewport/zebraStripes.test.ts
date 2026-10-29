// The zebra stripe coordinate the shader mirrors. A maker judges joins by it: a G0 corner breaks the
// stripes, a G1 fillet kinks them, a G2 blend lets them flow. Flat faces stay striped in every
// orientation, and only an orbit moves the stripes over the model.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  type Vec3,
  type ZebraDirection,
  zebraStripeCoord,
} from "../../src/viewport/zebraStripes";

const DIRS: ZebraDirection[] = ["horizontal", "vertical"];
const REACH = 40;
const CENTRE: Vec3 = [0, -10, -10];
const EYE: Vec3 = [30, 60, 45];

function viewFrom(eye: Vec3, target: Vec3 = [0, 0, 0]): THREE.Matrix4 {
  const cam = new THREE.PerspectiveCamera();
  cam.up.set(0, 0, 1);
  cam.position.set(...eye);
  cam.lookAt(...target);
  cam.updateMatrixWorld();
  return cam.matrixWorldInverse.clone();
}

const toView = (m: THREE.Matrix4, p: Vec3): Vec3 => {
  const v = new THREE.Vector3(...p).applyMatrix4(m);
  return [v.x, v.y, v.z];
};

const dirToView = (m: THREE.Matrix4, n: Vec3): Vec3 => {
  const v = new THREE.Vector3(...n).transformDirection(m);
  return [v.x, v.y, v.z];
};

function stripe(view: THREE.Matrix4, p: Vec3, n: Vec3, dir: ZebraDirection, centre = CENTRE): number {
  return zebraStripeCoord(toView(view, p), dirToView(view, n), toView(view, centre), dir, REACH);
}

// A top face along +y that rolls down over the edge at y = 0, turning by theta(s) after the edge.
function rollOver(theta: (s: number) => number, s: number): { p: Vec3; n: Vec3 } {
  if (s <= 0) return { p: [0, s, 0], n: [0, 0, 1] };
  const steps = 2000;
  const ds = s / steps;
  let y = 0;
  let z = 0;
  for (let i = 0; i < steps; i++) {
    const t = theta((i + 0.5) * ds);
    y += Math.cos(t) * ds;
    z -= Math.sin(t) * ds;
  }
  const t = theta(s);
  return { p: [0, y, z], n: [0, Math.sin(t), Math.cos(t)] };
}

const RADIUS = 8;
const RAMP = 10;
const circular = (s: number) => s / RADIUS;
// curvature grows linearly from 0 to 1 / RADIUS over RAMP, a G2 blend
const clothoid = (s: number) => (s * s) / (2 * RAMP * RADIUS);

function acrossJoin(theta: (s: number) => number, dir: ZebraDirection) {
  const view = viewFrom(EYE);
  const u = (s: number) => {
    const { p, n } = rollOver(theta, s);
    return stripe(view, p, n, dir);
  };
  const h = 1e-3;
  const before = (u(0) - u(-h)) / h;
  const after = (u(h) - u(0)) / h;
  return { gap: Math.abs(u(1e-7) - u(-1e-7)), kink: Math.abs(after - before) };
}

describe("zebra stripe coordinate", () => {
  it.each(DIRS)("breaks the %s stripes at a G0 corner", (dir) => {
    const view = viewFrom([50, -50, 50]);
    const edge: Vec3 = [4, -10, 10];
    const top = stripe(view, edge, [0, 0, 1], dir, [0, 0, 0]);
    const front = stripe(view, edge, [0, -1, 0], dir, [0, 0, 0]);
    expect(Math.abs(top - front)).toBeGreaterThan(0.3 * REACH);
  });

  it.each(DIRS)("keeps the %s stripes joined across a G1 fillet but kinks them", (dir) => {
    const { gap, kink } = acrossJoin(circular, dir);
    expect(gap).toBeLessThan(1e-3);
    expect(kink).toBeGreaterThan(1);
  });

  it.each(DIRS)("lets the %s stripes flow on across a G2 blend", (dir) => {
    const { gap, kink } = acrossJoin(clothoid, dir);
    expect(gap).toBeLessThan(1e-3);
    expect(kink).toBeLessThan(0.05);
  });

  it.each(DIRS)("stripes every visible flat face straight and evenly, %s", (dir) => {
    const p0: Vec3 = [3, -2, -50];
    const c: Vec3 = [0, 0, -50];
    for (let i = 0; i <= 12; i++) {
      const polar = (i / 12) * Math.acos(0.1);
      for (let j = 0; j < 24; j++) {
        const az = (j / 24) * 2 * Math.PI;
        const n: Vec3 = [Math.sin(polar) * Math.cos(az), Math.sin(polar) * Math.sin(az), Math.cos(polar)];
        // the face point under screen offset (dx, dy), in view space where the screen is x and y
        const at = (dx: number, dy: number) =>
          zebraStripeCoord(
            [p0[0] + dx, p0[1] + dy, p0[2] - (n[0] * dx + n[1] * dy) / n[2]],
            n,
            c,
            dir,
            REACH,
          );
        const gx = at(1, 0) - at(0, 0);
        const gy = at(0, 1) - at(0, 0);
        expect(at(2, 0) - at(0, 0)).toBeCloseTo(2 * gx, 9);
        expect(at(1, 1) - at(0, 0)).toBeCloseTo(gx + gy, 9);
        // the screen gradient sets the stripe width: never denser than nominal, at most about twice as wide
        const g = Math.hypot(gx, gy);
        expect(g).toBeGreaterThan(0.45);
        expect(g).toBeLessThan(1 + 1e-9);
      }
    }
  });

  it.each(DIRS)("leaves the %s stripes still on a pan or dolly and moves them on an orbit", (dir) => {
    const view = viewFrom(EYE);
    const shift: Vec3 = [7, -3, 11];
    const panned = viewFrom([EYE[0] + shift[0], EYE[1] + shift[1], EYE[2] + shift[2]], shift);
    const dollied = viewFrom([EYE[0] * 0.4, EYE[1] * 0.4, EYE[2] * 0.4]);
    const orbited = viewFrom([60, 30, 45]);
    let moved = 0;
    for (const s of [-6, 0.5, 3, 9]) {
      const { p, n } = rollOver(circular, s);
      const u = stripe(view, p, n, dir);
      expect(stripe(panned, p, n, dir)).toBeCloseTo(u, 9);
      expect(stripe(dollied, p, n, dir)).toBeCloseTo(u, 9);
      moved = Math.max(moved, Math.abs(stripe(orbited, p, n, dir) - u));
    }
    expect(moved).toBeGreaterThan(1);
  });

  it("reads a back facing normal like the front, as a double sided face does", () => {
    const pv: Vec3 = [2, 1, -40];
    const nv: Vec3 = [0.3, -0.5, 0.81];
    const back: Vec3 = [-nv[0], -nv[1], -nv[2]];
    for (const dir of DIRS) {
      expect(zebraStripeCoord(pv, back, [0, 0, -45], dir, REACH)).toBeCloseTo(
        zebraStripeCoord(pv, nv, [0, 0, -45], dir, REACH),
        12,
      );
    }
  });
});
