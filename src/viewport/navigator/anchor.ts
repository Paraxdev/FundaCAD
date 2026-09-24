// Where a zoom, a pan or an orbit takes hold of the world.
//
// A zoom anchor over empty space used to be a ground hit up to twenty target
// distances away, or a point on a sphere around the camera; zooming toward
// either carried the target off the model for good. The order here never
// reaches further than twice the eye distance and never casts more than 17
// rays into the scene.

import * as THREE from "three";
import type { NavScene } from "../cameras";
import {
  distanceOf, forwardOf, project, rayAt, rayDepth, rayPointAtDepth,
  type Frame, type Pose, type Ray,
} from "./pose";

export interface AnchorContext {
  scene: NavScene | null;
  /** The open sketch's plane, which is preferred over the ground. */
  plane: THREE.Plane | null;
  box: THREE.Box3 | null;
  frame: Frame;
}

export type AnchorKind = "model" | "plane" | "probe" | "box" | "target";

export interface Anchor {
  point: THREE.Vector3;
  kind: AnchorKind;
  /** Depth in front of the eye along the view axis. */
  depth: number;
}

/** Probe offsets in pixels, as fractions of the viewport height: two rings of
 *  eight, the outer one turned half a step so together they cover sixteen
 *  directions. */
const RING: readonly [number, number][] = (() => {
  const out: [number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    out.push([0.08 * Math.cos(a), 0.08 * Math.sin(a)]);
  }
  for (let i = 0; i < 8; i++) {
    const a = ((i + 0.5) * Math.PI) / 4;
    out.push([0.2 * Math.cos(a), 0.2 * Math.sin(a)]);
  }
  return out;
})();
export const PROBE_COUNT = RING.length;

const corner = new THREE.Vector3();
const fwdS = new THREE.Vector3();

/** The depth range of a box along the view axis, [NaN, NaN] for none. */
export function boxDepthRange(p: Pose, box: THREE.Box3 | null): [number, number] {
  if (!box || box.isEmpty()) return [NaN, NaN];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    const z = depthFromEye(p, corner);
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  return [lo, hi];
}

const eyeS = new THREE.Vector3();
function depthFromEye(p: Pose, point: THREE.Vector3): number {
  const f = forwardOf(p, fwdS);
  eyeS.copy(p.target).addScaledVector(f, -distanceOf(p));
  return (point.x - eyeS.x) * f.x + (point.y - eyeS.y) * f.y + (point.z - eyeS.z) * f.z;
}

/** How far behind the eye an orthographic ray has to start to see everything
 *  the camera draws. */
export function orthoBack(p: Pose, box: THREE.Box3 | null): number {
  const [lo] = boxDepthRange(p, box);
  const d = distanceOf(p);
  return Math.max(d, Number.isFinite(lo) ? -lo + d * 0.01 : 0);
}

function castRay(p: Pose, ctx: AnchorContext, x: number, y: number): Ray {
  return rayAt(p, ctx.frame, x, y, p.ortho ? orthoBack(p, ctx.box) : 0);
}

function modelDepth(p: Pose, ctx: AnchorContext, ray: Ray): number | null {
  if (!ctx.scene) return null;
  const t = ctx.scene.raycast(ray.origin, ray.dir);
  if (t === null || !Number.isFinite(t) || t < 0) return null;
  return rayDepth(p, ray, t);
}

const groundPlane = new THREE.Plane();
function planeDepth(p: Pose, ctx: AnchorContext, ray: Ray): number | null {
  let plane = ctx.plane;
  if (!plane) {
    const gz = ctx.scene?.groundZ() ?? null;
    if (gz === null || !Number.isFinite(gz)) return null;
    plane = groundPlane.set(new THREE.Vector3(0, 0, 1), -gz);
  }
  const denom = plane.normal.dot(ray.dir);
  if (!(Math.abs(denom) > 1e-9)) return null;
  const t = -(plane.normal.dot(ray.origin) + plane.constant) / denom;
  if (!(t > 0)) return null;
  const depth = rayDepth(p, ray, t);
  if (!(depth <= 2 * distanceOf(p))) return null;
  if (!p.ortho && !(depth > 0)) return null;
  return depth;
}

function boxEntryDepth(p: Pose, ctx: AnchorContext, ray: Ray): number | null {
  const box = ctx.box;
  if (!box || box.isEmpty()) return null;
  let tmin = -Infinity;
  let tmax = Infinity;
  for (const k of ["x", "y", "z"] as const) {
    const o = ray.origin[k];
    const d = ray.dir[k];
    if (Math.abs(d) < 1e-15) {
      if (o < box.min[k] || o > box.max[k]) return null;
      continue;
    }
    let a = (box.min[k] - o) / d;
    let b = (box.max[k] - o) / d;
    if (a > b) [a, b] = [b, a];
    tmin = Math.max(tmin, a);
    tmax = Math.min(tmax, b);
  }
  if (!(tmin <= tmax) || !(tmin > 0)) return null;
  const depth = rayDepth(p, ray, tmin);
  if (!p.ortho && !(depth > 0)) return null;
  return depth;
}

/** The zoom anchor under a pixel: the model, then the sketch plane or the
 *  ground within 2·d, then the depth of the nearest model surface around the
 *  cursor, then where the ray enters the content box, then the target's depth. */
export function zoomAnchor(p: Pose, ctx: AnchorContext, x: number, y: number): Anchor {
  const ray = castRay(p, ctx, x, y);
  const at = (depth: number, kind: AnchorKind): Anchor =>
    ({ point: rayPointAtDepth(p, ray, depth), kind, depth });
  const m = modelDepth(p, ctx, ray);
  if (m !== null) return at(m, "model");
  const pl = planeDepth(p, ctx, ray);
  if (pl !== null) return at(pl, "plane");
  const probe = probeRing(p, ctx, x, y);
  if (probe) return at(probe.minDepth, "probe");
  const b = boxEntryDepth(p, ctx, ray);
  if (b !== null) return at(b, "box");
  return at(distanceOf(p), "target");
}

interface ProbeResult {
  minDepth: number;
  /** The hit nearest the cursor on screen. */
  nearest: THREE.Vector3;
}

function probeRing(p: Pose, ctx: AnchorContext, x: number, y: number): ProbeResult | null {
  if (!ctx.scene) return null;
  const h = ctx.frame.height;
  let minDepth = Infinity;
  let nearest: THREE.Vector3 | null = null;
  for (const [dx, dy] of RING) {
    const px = x + dx * h;
    const py = y + dy * h;
    if (px < 0 || py < 0 || px > ctx.frame.width || py > ctx.frame.height) continue;
    const ray = castRay(p, ctx, px, py);
    const d = modelDepth(p, ctx, ray);
    if (d === null || (!p.ortho && !(d > 0))) continue;
    if (!nearest) nearest = rayPointAtDepth(p, ray, d);
    minDepth = Math.min(minDepth, d);
  }
  return nearest ? { minDepth, nearest } : null;
}

/** The point a drag starting at this pixel orbits about: the model under it,
 *  then the nearest model surface around it, then the content's centre while
 *  that is on screen, then the target. */
export function orbitPivot(p: Pose, ctx: AnchorContext, x: number, y: number): THREE.Vector3 {
  const ray = castRay(p, ctx, x, y);
  const m = modelDepth(p, ctx, ray);
  if (m !== null) return rayPointAtDepth(p, ray, m);
  const probe = probeRing(p, ctx, x, y);
  if (probe) return probe.nearest;
  if (ctx.box && !ctx.box.isEmpty()) {
    const c = ctx.box.getCenter(new THREE.Vector3());
    const s = project(p, ctx.frame, c);
    const inFront = p.ortho || s.depth > 0;
    if (inFront && s.x >= 0 && s.y >= 0 && s.x <= ctx.frame.width && s.y <= ctx.frame.height) return c;
  }
  return p.target.clone();
}

/** Depth of the surface at the centre of the screen, or null for none: the
 *  model, then the sketch plane or ground within 2·d. */
export function centreDepth(p: Pose, ctx: AnchorContext): number | null {
  const ray = castRay(p, ctx, ctx.frame.width / 2, ctx.frame.height / 2);
  return modelDepth(p, ctx, ray) ?? planeDepth(p, ctx, ray);
}
