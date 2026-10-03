// The guides a round face resize draws on the model: a thin line down the
// face's axis, and a dashed one from the axis out to the handle, across the
// whole diameter on a full round, so the size being set reads on the model.

import * as THREE from "three";
import type { Vec3 } from "../types";
import { themeColor } from "../viewport/themeColors";
import { HANDLE_IDLE } from "./manipulator";
import { anchorOnAxis, type ResizeAxis } from "./pressPullAxis";

/** How far the axis line runs past the face, as a fraction of the face's length. */
export const AXIS_OVERHANG = 0.15;

const DASH_PX = 5;

/** Where `points` start and end along the axis, measured from its origin. */
export function axialSpan(points: readonly Vec3[], axis: ResizeAxis): [number, number] | null {
  const [ox, oy, oz] = axis.origin;
  const [dx, dy, dz] = axis.dir;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const t = (p[0] - ox) * dx + (p[1] - oy) * dy + (p[2] - oz) * dz;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return hi >= lo ? [lo, hi] : null;
}

/** The axis line over a face's span, longer by `overhang` of it, split evenly between the ends. */
export function axisLine(axis: ResizeAxis, span: readonly [number, number], overhang = AXIS_OVERHANG): [Vec3, Vec3] {
  const pad = ((span[1] - span[0]) * overhang) / 2;
  const at = (t: number): Vec3 => [
    axis.origin[0] + axis.dir[0] * t,
    axis.origin[1] + axis.dir[1] * t,
    axis.origin[2] + axis.dir[2] * t,
  ];
  return [at(span[0] - pad), at(span[1] + pad)];
}

/** The dashed size line ending at the handle: from the axis foot for a radius,
 *  from the opposite wall through the axis for a diameter. */
export function sizeLine(handle: Vec3, axis: ResizeAxis, full: boolean): [Vec3, Vec3] {
  const f = anchorOnAxis(handle, { ...axis, hole: false });
  if (!full) return [f, handle];
  return [[2 * f[0] - handle[0], 2 * f[1] - handle[1], 2 * f[2] - handle[2]], handle];
}

export interface GuideHost {
  addToScene(o: THREE.Object3D): void;
  removeFromScene(o: THREE.Object3D): void;
  pixelWorldSize(at: THREE.Vector3): number;
  requestRender(): void;
}

export interface GuideState {
  axis: ResizeAxis;
  span: readonly [number, number];
  handle: THREE.Vector3;
  full: boolean;
}

function segment(mat: THREE.LineBasicMaterial | THREE.LineDashedMaterial): THREE.Line {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  geo.setAttribute("lineDistance", new THREE.Float32BufferAttribute(new Float32Array(2), 1));
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 998;
  line.frustumCulled = false;
  return line;
}

/** Writes the ends into the line in place, true when they moved. */
function setEnds(line: THREE.Line, a: Vec3, b: Vec3): boolean {
  const pos = line.geometry.getAttribute("position") as THREE.BufferAttribute;
  const next = [...a, ...b];
  if (next.every((v, i) => Math.abs(pos.array[i]! - v) < 1e-9)) return false;
  (pos.array as Float32Array).set(next);
  pos.needsUpdate = true;
  const dist = line.geometry.getAttribute("lineDistance") as THREE.BufferAttribute;
  dist.setX(1, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  dist.needsUpdate = true;
  return true;
}

export class ResizeGuides {
  axisLine: THREE.Line | null = null;
  sizeLine: THREE.Line | null = null;
  private host: GuideHost | null = null;

  update(host: GuideHost, s: GuideState) {
    const overlay = { transparent: true, depthTest: false, depthWrite: false };
    const ink = themeColor("--accent", HANDLE_IDLE);
    if (!this.axisLine || !this.sizeLine) {
      this.host = host;
      this.axisLine = segment(new THREE.LineBasicMaterial({ color: ink, opacity: 0.7, ...overlay }));
      this.sizeLine = segment(new THREE.LineDashedMaterial({ color: ink, opacity: 0.95, dashSize: 1, gapSize: 1, ...overlay }));
      this.axisLine.name = "resize-axis";
      this.sizeLine.name = "resize-size";
      host.addToScene(this.axisLine);
      host.addToScene(this.sizeLine);
    }
    const [a0, a1] = axisLine(s.axis, s.span);
    const [s0, s1] = sizeLine([s.handle.x, s.handle.y, s.handle.z], s.axis, s.full);
    let moved = setEnds(this.axisLine, a0, a1);
    moved = setEnds(this.sizeLine, s0, s1) || moved;
    const dash = host.pixelWorldSize(s.handle) * DASH_PX;
    const mat = this.sizeLine.material as THREE.LineDashedMaterial;
    if (Math.abs(mat.dashSize - dash) > 1e-12) {
      mat.dashSize = dash;
      mat.gapSize = dash * 0.7;
      moved = true;
    }
    if (moved) host.requestRender();
  }

  clear() {
    const host = this.host;
    for (const line of [this.axisLine, this.sizeLine]) {
      if (!line) continue;
      host?.removeFromScene(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.axisLine = null;
    this.sizeLine = null;
    this.host = null;
  }
}
