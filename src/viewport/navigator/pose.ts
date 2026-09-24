// The one pose on screen.
//
// The target T always lies on the view axis, and `scale` is half the visible
// height at T. The eye is derived, eye = T - forward·d with d = scale/tan(fov/2),
// in BOTH projections: an orthographic camera placed there with a half height of
// `scale` shows exactly what the perspective one shows at T, so swapping
// projections moves nothing at T and a later swap back finds the eye in front
// of what was being looked at.

import * as THREE from "three";
import { decompose, finiteQuat, finiteVec, turntableQuat } from "./math";

export interface Pose {
  target: THREE.Vector3;
  q: THREE.Quaternion;
  scale: number;
  /** Vertical field of view in degrees, kept while orthographic too. */
  fov: number;
  ortho: boolean;
  /** Right vector horizontal and up not below it: a turntable orientation. */
  level: boolean;
  /** Valid while level; q is rebuilt from these so turntable steps stay exact. */
  yaw: number;
  elev: number;
}

export function makePose(): Pose {
  return {
    target: new THREE.Vector3(),
    q: turntableQuat(0, Math.PI / 2),
    scale: 50,
    fov: 45,
    ortho: false,
    level: true,
    yaw: 0,
    elev: Math.PI / 2,
  };
}

export function copyPose(out: Pose, p: Pose): Pose {
  out.target.copy(p.target);
  out.q.copy(p.q);
  out.scale = p.scale;
  out.fov = p.fov;
  out.ortho = p.ortho;
  out.level = p.level;
  out.yaw = p.yaw;
  out.elev = p.elev;
  return out;
}

export function clonePose(p: Pose): Pose {
  return copyPose(makePose(), p);
}

export function halfTan(fovDeg: number): number {
  return Math.tan((fovDeg * Math.PI) / 360);
}

export function distanceOf(p: Pose): number {
  return p.scale / halfTan(p.fov);
}

export function forwardOf(p: Pose, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(0, 0, -1).applyQuaternion(p.q);
}
export function rightOf(p: Pose, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(1, 0, 0).applyQuaternion(p.q);
}
export function upOf(p: Pose, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(0, 1, 0).applyQuaternion(p.q);
}

const f0 = new THREE.Vector3();
export function eyeOf(p: Pose, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(p.target).addScaledVector(forwardOf(p, f0), -distanceOf(p));
}

/** Depth of a point in front of the eye, along the view axis. */
export function depthOf(p: Pose, point: THREE.Vector3): number {
  const e = eyeOf(p, f1);
  return f2.subVectors(point, e).dot(forwardOf(p, f0));
}
const f1 = new THREE.Vector3();
const f2 = new THREE.Vector3();

/** Orientation from a quaternion, marking it level (and caching its turntable
 *  angles) when it is one. */
export function setOrientation(p: Pose, q: THREE.Quaternion) {
  p.q.copy(q).normalize();
  const t = decompose(p.q);
  const right = rightOf(p, f1);
  const up = upOf(p, f2);
  if (Math.abs(right.z) < 1e-9 && up.z > -1e-9 && Math.abs(t.roll) < 1e-6) {
    setTurntable(p, t.yaw, t.elev);
  } else {
    p.level = false;
  }
}

export function setTurntable(p: Pose, yaw: number, elev: number) {
  p.yaw = yaw;
  p.elev = elev;
  p.level = true;
  turntableQuat(yaw, elev, p.q);
}

export function poseFinite(p: Pose): boolean {
  return finiteVec(p.target) && finiteQuat(p.q) && Number.isFinite(p.scale) && p.scale > 0
    && Number.isFinite(p.fov) && p.fov > 0 && p.fov < 180
    && Number.isFinite(p.yaw) && Number.isFinite(p.elev)
    && Math.abs(p.q.lengthSq() - 1) < 1e-6;
}

// --- screen <-> world ---------------------------------------------------------

/** A viewport in pixels, origin top left, y down. */
export interface Frame {
  width: number;
  height: number;
}

export function aspectOf(v: Frame): number {
  return v.width > 0 && v.height > 0 ? v.width / v.height : 1;
}

/** Pixel of a world point: x right, y down, and its depth in front of the eye. */
export function project(p: Pose, v: Frame, point: THREE.Vector3): { x: number; y: number; depth: number } {
  const e = eyeOf(p, f1);
  const rel = f2.subVectors(point, e);
  const fwd = forwardOf(p, f0);
  const depth = rel.dot(fwd);
  const rx = rel.dot(rightOf(p, f3));
  const uy = rel.dot(upOf(p, f3));
  const a = aspectOf(v);
  const denom = p.ortho ? p.scale : depth * halfTan(p.fov);
  const nx = rx / (denom * a);
  const ny = uy / denom;
  return { x: ((nx + 1) / 2) * v.width, y: ((1 - ny) / 2) * v.height, depth };
}
const f3 = new THREE.Vector3();

export interface Ray {
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  /** Depth of `origin` along the view axis, measured from the eye. Negative
   *  for an orthographic ray, which starts behind the eye so geometry the
   *  camera sits inside still counts. */
  originDepth: number;
}

/** The world ray through a pixel. Orthographic rays start `back` behind the
 *  eye, because an orthographic camera draws what is behind it too. */
export function rayAt(p: Pose, v: Frame, x: number, y: number, back = 0, out?: Ray): Ray {
  const r = out ?? { origin: new THREE.Vector3(), dir: new THREE.Vector3(), originDepth: 0 };
  const a = aspectOf(v);
  const nx = (x / Math.max(1, v.width)) * 2 - 1;
  const ny = 1 - (y / Math.max(1, v.height)) * 2;
  const fwd = forwardOf(p, f0);
  const right = rightOf(p, f1);
  const up = upOf(p, f2);
  const e = eyeOf(p, f3);
  if (p.ortho) {
    r.origin.copy(e)
      .addScaledVector(right, nx * p.scale * a)
      .addScaledVector(up, ny * p.scale)
      .addScaledVector(fwd, -back);
    r.dir.copy(fwd);
    r.originDepth = -back;
  } else {
    const h = halfTan(p.fov);
    r.origin.copy(e);
    r.dir.copy(fwd).addScaledVector(right, nx * h * a).addScaledVector(up, ny * h).normalize();
    r.originDepth = 0;
  }
  return r;
}

/** Depth along the view axis of the point `t` along a ray from rayAt. */
export function rayDepth(p: Pose, ray: Ray, t: number): number {
  return ray.originDepth + t * ray.dir.dot(forwardOf(p, f0));
}

/** The point on a ray at a given depth. */
export function rayPointAtDepth(p: Pose, ray: Ray, depth: number, out = new THREE.Vector3()): THREE.Vector3 {
  const k = ray.dir.dot(forwardOf(p, f0));
  const t = k > 1e-12 ? (depth - ray.originDepth) / k : 0;
  return out.copy(ray.origin).addScaledVector(ray.dir, t);
}

/** World units per pixel at a depth (the same everywhere when orthographic). */
export function worldPerPixel(p: Pose, v: Frame, depth: number): number {
  const h = Math.max(1, v.height);
  return p.ortho ? (2 * p.scale) / h : (2 * depth * halfTan(p.fov)) / h;
}
