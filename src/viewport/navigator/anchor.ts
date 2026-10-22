// Where a zoom, a pan or an orbit takes hold of the world. The order never reaches past twice the eye distance or casts
// more than 17 rays, so a zoom over empty space cannot carry the target off the model.

import * as THREE from "three";
import type { NavScene } from "../cameras";
import {
  distanceOf,
  forwardOf,
  halfTan,
  project,
  rayAt,
  rayDepth,
  rayPointAtDepth,
  rightOf,
  upOf,
  type Frame,
  type Pose,
  type Ray,
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

/** Probe offsets as fractions of the viewport height: two rings of eight, the outer turned half a step, sixteen
 *  directions in all. */
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

const eyeV = new THREE.Vector3();
const fwdV = new THREE.Vector3();
const rightV = new THREE.Vector3();
const upV = new THREE.Vector3();

/** Least depth at which any box is inside the perspective frustum, NaN for none. A box wholly in front counts from its
 *  nearest corner, which may be off screen, so the answer never passes a part. */
export function visibleNearDepth(p: Pose, aspect: number, boxes: readonly THREE.Box3[]): number {
  forwardOf(p, fwdV);
  rightOf(p, rightV);
  upOf(p, upV);
  eyeV.copy(p.target).addScaledVector(fwdV, -distanceOf(p));
  const ty = halfTan(p.fov) * 1.02;
  const tx = ty * (aspect > 0 && Number.isFinite(aspect) ? aspect : 1);
  let best = Infinity;
  for (const box of boxes) {
    if (box.isEmpty()) continue;
    let out = 31;
    let lo = Infinity;
    for (let i = 0; i < 8; i++) {
      const dx = (i & 1 ? box.max.x : box.min.x) - eyeV.x;
      const dy = (i & 2 ? box.max.y : box.min.y) - eyeV.y;
      const dz = (i & 4 ? box.max.z : box.min.z) - eyeV.z;
      const z = dx * fwdV.x + dy * fwdV.y + dz * fwdV.z;
      const x = dx * rightV.x + dy * rightV.y + dz * rightV.z;
      const y = dx * upV.x + dy * upV.y + dz * upV.z;
      out &=
        (z <= 0 ? 1 : 0) | (x > z * tx ? 2 : 0) | (-x > z * tx ? 4 : 0) | (y > z * ty ? 8 : 0) | (-y > z * ty ? 16 : 0);
      lo = Math.min(lo, z);
    }
    if (out) continue;
    const z = lo > 0 ? lo : nearestInFrustum(box, tx, ty);
    if (z < best) best = z;
    if (best === 0) break;
  }
  return best === Infinity ? NaN : best;
}

// Half-spaces n.v <= c in view coordinates (x right, y up, z depth): the box's
// six faces and the frustum's four sides and eye plane.
type Half = [number, number, number, number];

/** Least depth of the part of `box` inside the frustum, Infinity if none: a three variable LP solved at the vertices of
 *  the eleven half-spaces. Only boxes reaching behind the eye get here. */
function nearestInFrustum(box: THREE.Box3, tx: number, ty: number): number {
  const hs: Half[] = [
    [1, 0, -tx, 0],
    [-1, 0, -tx, 0],
    [0, 1, -ty, 0],
    [0, -1, -ty, 0],
    [0, 0, -1, 0],
  ];
  for (const k of ["x", "y", "z"] as const) {
    const n: [number, number, number] = [rightV[k], upV[k], fwdV[k]];
    hs.push([n[0], n[1], n[2], box.max[k] - eyeV[k]], [-n[0], -n[1], -n[2], eyeV[k] - box.min[k]]);
  }
  const eps = 1e-9 * Math.max(1, box.max.distanceTo(box.min), eyeV.length());
  let best = Infinity;
  const m = hs.length;
  for (let i = 0; i < m; i++)
    for (let j = i + 1; j < m; j++)
      for (let k = j + 1; k < m; k++) {
        const [a1, b1, c1, d1] = hs[i]!;
        const [a2, b2, c2, d2] = hs[j]!;
        const [a3, b3, c3, d3] = hs[k]!;
        const det = a1 * (b2 * c3 - b3 * c2) - b1 * (a2 * c3 - a3 * c2) + c1 * (a2 * b3 - a3 * b2);
        if (Math.abs(det) < 1e-12) continue;
        const z = (a1 * (b2 * d3 - b3 * d2) - b1 * (a2 * d3 - a3 * d2) + d1 * (a2 * b3 - a3 * b2)) / det;
        if (!(z < best)) continue;
        const x = (d1 * (b2 * c3 - b3 * c2) - b1 * (d2 * c3 - d3 * c2) + c1 * (d2 * b3 - d3 * b2)) / det;
        const y = (a1 * (d2 * c3 - d3 * c2) - d1 * (a2 * c3 - a3 * c2) + c1 * (a2 * d3 - a3 * d2)) / det;
        if (hs.every(([a, b, c, d]) => a * x + b * y + c * z <= d + eps)) best = z;
      }
  return Math.max(0, best);
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

/** The model under the pixel, then the sketch plane or ground within 2·d, then the nearest model surface around the
 *  cursor, then where the ray enters the content box, then the target's depth. */
export function zoomAnchor(p: Pose, ctx: AnchorContext, x: number, y: number): Anchor {
  const ray = castRay(p, ctx, x, y);
  const at = (depth: number, kind: AnchorKind): Anchor => ({ point: rayPointAtDepth(p, ray, depth), kind, depth });
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

/** The model under the pixel, then the nearest model surface around it, then the content's centre while on screen,
 *  then the target. */
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
