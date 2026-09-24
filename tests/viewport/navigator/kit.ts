// Headless pieces for driving the navigator: an analytic scene of boxes over a
// ground plane, a seeded random source, and frame stepping.

import * as THREE from "three";
import type { NavScene } from "../../../src/viewport/cameras";
import { Navigator } from "../../../src/viewport/navigator/navigator";
import { eyeOf, forwardOf, project, rightOf } from "../../../src/viewport/navigator/pose";

export const W = 800;
export const H = 600;

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class BoxScene implements NavScene {
  boxes: THREE.Box3[];
  ground: number | null;
  rays = 0;
  constructor(boxes: THREE.Box3[], ground: number | null = null) {
    this.boxes = boxes;
    this.ground = ground;
  }
  raycast(origin: THREE.Vector3, dir: THREE.Vector3): number | null {
    this.rays++;
    let best: number | null = null;
    for (const b of this.boxes) {
      const t = rayBox(origin, dir, b);
      if (t !== null && (best === null || t < best)) best = t;
    }
    return best;
  }
  groundZ(): number | null {
    return this.ground;
  }
  box(): THREE.Box3 {
    const out = new THREE.Box3();
    for (const b of this.boxes) out.union(b);
    return out;
  }
}

/** Entry distance of a ray into a box, or null (a ray starting inside hits the
 *  far wall, as a mesh raycast would). */
export function rayBox(o: THREE.Vector3, d: THREE.Vector3, b: THREE.Box3): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (const k of ["x", "y", "z"] as const) {
    if (Math.abs(d[k]) < 1e-15) {
      if (o[k] < b.min[k] || o[k] > b.max[k]) return null;
      continue;
    }
    let a = (b.min[k] - o[k]) / d[k];
    let c = (b.max[k] - o[k]) / d[k];
    if (a > c) [a, c] = [c, a];
    tmin = Math.max(tmin, a);
    tmax = Math.min(tmax, c);
  }
  if (tmin > tmax || tmax < 0) return null;
  return tmin >= 0 ? tmin : tmax;
}

export const UNIT_BOX = new THREE.Box3(new THREE.Vector3(-20, -15, 0), new THREE.Vector3(20, 15, 20));

export interface Setup {
  nav: Navigator;
  scene: BoxScene;
}

/** A navigator looking at `boxes` from the home corner, framed, settled. */
export function setup(opts: { boxes?: THREE.Box3[]; ground?: number | null; tau?: number; ortho?: boolean } = {}): Setup {
  const nav = new Navigator();
  nav.setFrame(W, H);
  const scene = new BoxScene(opts.boxes ?? [UNIT_BOX.clone()], opts.ground ?? null);
  nav.setScene(scene);
  nav.setContentBox(scene.box());
  nav.opts.smoothTime = opts.tau ?? 0.125;
  nav.setProjectionMode(opts.ortho ? "ortho" : "persp");
  const b = scene.box();
  const sphere = b.getBoundingSphere(new THREE.Sphere());
  nav.resetView(sphere.center, sphere.radius, false);
  settle(nav);
  return { nav, scene };
}

/** Step until nothing moves (or a cap), `dt` seconds a frame. */
export function settle(nav: Navigator, dt = 1 / 60, cap = 2000): number {
  let frames = 0;
  while (frames < cap) {
    const moved = nav.update(dt);
    frames++;
    if (!moved && !nav.isBusy()) break;
  }
  return frames;
}

export function pixel(nav: Navigator, p: THREE.Vector3): { x: number; y: number; depth: number } {
  return project(nav.pose, nav.frame, p);
}

/** Pixels of a spread of points, for "nothing on screen moved" checks. */
export function screenPrint(nav: Navigator, pts: THREE.Vector3[]): number[] {
  const out: number[] = [];
  for (const p of pts) {
    const s = pixel(nav, p);
    out.push(s.x, s.y);
  }
  return out;
}

export function probePoints(box: THREE.Box3): THREE.Vector3[] {
  const c = box.getCenter(new THREE.Vector3());
  const pts = [c.clone()];
  for (let i = 0; i < 8; i++) {
    pts.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
  }
  return pts;
}

export function maxDiff(a: number[], b: number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

export function rightZ(nav: Navigator): number {
  return rightOf(nav.pose, new THREE.Vector3()).z;
}

export function eye(nav: Navigator): THREE.Vector3 {
  return eyeOf(nav.pose, new THREE.Vector3());
}

export function fwd(nav: Navigator): THREE.Vector3 {
  return forwardOf(nav.pose, new THREE.Vector3());
}

/** True when the segment from the eye to `p` passes through no box before p. */
export function lineOfSightClear(scene: BoxScene, from: THREE.Vector3, p: THREE.Vector3): boolean {
  const d = p.clone().sub(from);
  const len = d.length();
  d.normalize();
  for (const b of scene.boxes) {
    if (b.containsPoint(from)) return false;
    const t = rayBox(from, d, b);
    if (t !== null && t < len * (1 - 1e-9) - 1e-9) return false;
  }
  return true;
}

export const TAUS = [0, 0.125] as const;
