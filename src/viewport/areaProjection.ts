// What a box drag needs of the model, taken once per drag. Faces are tested by their clusters' screen boxes
// (areaIndex.ts) and only the triangles of clusters the box's edges cut are projected, so a drag never pays for the
// whole mesh. Each triangle verdict is the one a full projection gave.

import * as THREE from "three";
import type { EdgeRef, ModelView } from "./render";
import { areaIndexOf, type BodyAreaIndex } from "./areaIndex";
import {
  allInsideRect,
  boxOf,
  boxVerdict,
  convexTouchesRect,
  polylineInBox,
  type AreaMode,
  type ScreenBox,
  type ScreenRect,
} from "./areaSelect";

/** Counters a test reads: triangles tested and vertices projected for a drag's verdicts. */
export const areaWork = { triangles: 0, vertices: 0 };

// Cluster boxes are compared with this much slack, so rounding can only send a cluster to its triangles.
const SLACK_PX = 1e-6;

interface BodyArea {
  id: string;
  idx: BodyAreaIndex;
  P: ArrayLike<number>;
  I: ArrayLike<number>;
  mw: THREE.Matrix4;
  faceIds: number[];
  /** x0, y0, x1, y1 per cluster, NaN in x0 when a corner is behind the camera. */
  screen: Float64Array;
  /** 0 not yet known, 1 has a triangle facing the camera, 2 has none. */
  facing: Int8Array;
}

export interface AreaProjection {
  bodies: BodyArea[];
  edges: { ref: EdgeRef; flat: number[] | null; box: ScreenBox }[];
  vp: THREE.Matrix4;
  view: DOMRect;
  seeThrough: boolean;
  ortho: boolean;
  camDir: THREE.Vector3;
  camPos: THREE.Vector3;
}

function flatXyz(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): ArrayLike<number> {
  const plain = !(pos as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && !pos.normalized;
  if (plain && pos.itemSize === 3) return (pos as THREE.BufferAttribute).array;
  const out = new Float64Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = pos.getX(i);
    out[i * 3 + 1] = pos.getY(i);
    out[i * 3 + 2] = pos.getZ(i);
  }
  return out;
}

/** `seeThrough` keeps the far side: without it back-facing triangles are culled. */
export function projectForArea(
  model: Pick<ModelView, "bodies" | "edges">,
  cam: THREE.Camera,
  view: DOMRect,
  seeThrough: boolean,
): AreaProjection {
  cam.updateMatrixWorld();
  const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const out: AreaProjection = {
    bodies: [],
    edges: [],
    vp,
    view,
    seeThrough,
    ortho: (cam as THREE.OrthographicCamera).isOrthographicCamera === true,
    camDir: cam.getWorldDirection(new THREE.Vector3()),
    camPos: cam.position.clone(),
  };
  for (const body of model.bodies) {
    if (!body.mesh.visible) continue;
    const geom = body.mesh.geometry;
    const pos = geom.getAttribute("position");
    const index = geom.getIndex();
    if (!pos || !index) continue;
    const idx = areaIndexOf(body);
    if (!idx) continue;
    const mw = body.mesh.matrixWorld;
    const n = idx.clusterStart.length;
    const screen = new Float64Array(n * 4);
    const B = idx.clusterBox;
    // A box's corners are its first corner plus the clip space images of its three edges.
    const m = new THREE.Matrix4().multiplyMatrices(vp, mw).elements;
    const cx = [0, 0, 0, 0, 0, 0, 0, 0],
      cy = [0, 0, 0, 0, 0, 0, 0, 0],
      cw = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let c = 0; c < n; c++) {
      const o = c * 6;
      const bx = B[o]!,
        by = B[o + 1]!,
        bz = B[o + 2]!;
      const ex = B[o + 3]! - bx,
        ey = B[o + 4]! - by,
        ez = B[o + 5]! - bz;
      cx[0] = m[0]! * bx + m[4]! * by + m[8]! * bz + m[12]!;
      cy[0] = m[1]! * bx + m[5]! * by + m[9]! * bz + m[13]!;
      cw[0] = m[3]! * bx + m[7]! * by + m[11]! * bz + m[15]!;
      for (let k = 1; k < 8; k++) {
        const j = k & (k - 1) ? k & (k - 1) : 0;
        const bit = k ^ j;
        const ax = bit === 1 ? 0 : bit === 2 ? 4 : 8;
        const len = bit === 1 ? ex : bit === 2 ? ey : ez;
        cx[k] = cx[j]! + m[ax]! * len;
        cy[k] = cy[j]! + m[ax + 1]! * len;
        cw[k] = cw[j]! + m[ax + 3]! * len;
      }
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let k = 0; k < 8; k++) {
        const w = cw[k]!;
        if (!(w > 0)) {
          x0 = NaN;
          break;
        }
        const sx = view.left + ((cx[k]! / w) * 0.5 + 0.5) * view.width;
        const sy = view.top + ((-cy[k]! / w) * 0.5 + 0.5) * view.height;
        if (sx < x0) x0 = sx;
        if (sy < y0) y0 = sy;
        if (sx > x1) x1 = sx;
        if (sy > y1) y1 = sy;
      }
      screen[c * 4] = Number.isFinite(x0 + y0 + x1 + y1) ? x0 : NaN;
      screen[c * 4 + 1] = y0;
      screen[c * 4 + 2] = x1;
      screen[c * 4 + 3] = y1;
    }
    const facing = new Int8Array(n);
    if (!seeThrough) coneFacing(idx, mw, out, facing);
    out.bodies.push({
      id: body.id,
      idx,
      P: flatXyz(pos),
      I: index.array,
      mw,
      faceIds: [...body.faceTriangles.keys()],
      screen,
      facing,
    });
  }

  // Edges are never culled by facing: a silhouette edge belongs to the face
  // pointing away as much as to the one pointing at you.
  const q = new THREE.Vector4();
  for (const e of model.edges) {
    if (!e.draw.object.visible) continue;
    const flat: number[] = [];
    let usable = true;
    for (const pt of e.points) {
      q.set(pt[0], pt[1], pt[2], 1).applyMatrix4(vp);
      if (!(q.w > 0)) {
        usable = false;
        break;
      }
      flat.push(
        view.left + ((q.x / q.w) * 0.5 + 0.5) * view.width,
        view.top + ((-q.y / q.w) * 0.5 + 0.5) * view.height,
      );
    }
    out.edges.push(usable ? { ref: e, flat, box: boxOf(flat) } : { ref: e, flat: null, box: null });
  }
  return out;
}

/** Settles the clusters whose normal cone faces wholly toward or away from the camera, the rest are probed when
 *  asked. World facing is the local one times the sign of the body transform's determinant. */
function coneFacing(idx: BodyAreaIndex, mw: THREE.Matrix4, proj: AreaProjection, facing: Int8Array) {
  const det = mw.determinant();
  if (!(det !== 0)) return;
  const inv = mw.clone().invert();
  const K = idx.clusterCone;
  const B = idx.clusterBox;
  // The view direction for ortho, the eye for perspective. transformDirection normalises, which keeps every sign.
  const eye = proj.ortho ? proj.camDir.clone().transformDirection(inv) : proj.camPos.clone().applyMatrix4(inv);
  for (let c = 0; c < facing.length; c++) {
    const cosT = K[c * 4 + 3]!;
    if (cosT < -1) continue;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    let vx: number, vy: number, vz: number, R: number;
    if (proj.ortho) {
      vx = eye.x;
      vy = eye.y;
      vz = eye.z;
      R = 0;
    } else {
      const o = c * 6;
      vx = (B[o]! + B[o + 3]!) / 2 - eye.x;
      vy = (B[o + 1]! + B[o + 4]!) / 2 - eye.y;
      vz = (B[o + 2]! + B[o + 5]!) / 2 - eye.z;
      R = Math.hypot(B[o + 3]! - B[o]!, B[o + 4]! - B[o + 1]!, B[o + 5]! - B[o + 2]!) / 2;
    }
    const D = Math.hypot(vx, vy, vz);
    if (!(D > 0)) continue;
    const cosA = (K[c * 4]! * vx + K[c * 4 + 1]! * vy + K[c * 4 + 2]! * vz) / D;
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const margin = 1e-6 * (D + R);
    let side = 0;
    if (cosA > -cosT && D * (cosA * cosT - sinA * sinT) - R > margin) side = 1;
    else if (cosA < cosT && D * (cosA * cosT + sinA * sinT) + R < -margin) side = -1;
    if (side !== 0) facing[c] = side * det < 0 ? 1 : 2;
  }
}

/** One triangle in world and screen space, in the operation order a full projection used, so verdicts match it. */
class TriProbe {
  readonly w = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  readonly s = [0, 0, 0, 0, 0, 0];
  private v = new THREE.Vector4();
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private c = new THREE.Vector3();
  private ab = new THREE.Vector3();
  private ac = new THREE.Vector3();
  private nrm = new THREE.Vector3();
  private look = new THREE.Vector3();

  constructor(private proj: AreaProjection) {}

  load(b: BodyArea, t: number) {
    const { vp, view } = this.proj;
    for (let k = 0; k < 3; k++) {
      const i = (b.I[t * 3 + k] as number) * 3;
      const p = this.v.set(b.P[i] as number, b.P[i + 1] as number, b.P[i + 2] as number, 1).applyMatrix4(b.mw);
      this.w[k * 3] = p.x;
      this.w[k * 3 + 1] = p.y;
      this.w[k * 3 + 2] = p.z;
      p.applyMatrix4(vp);
      if (!(p.w > 0)) {
        this.s[k * 2] = NaN;
        this.s[k * 2 + 1] = NaN;
        continue;
      }
      this.s[k * 2] = view.left + ((p.x / p.w) * 0.5 + 0.5) * view.width;
      this.s[k * 2 + 1] = view.top + ((-p.y / p.w) * 0.5 + 0.5) * view.height;
    }
    areaWork.vertices += 3;
    areaWork.triangles++;
  }

  /** After load. */
  facing(): boolean {
    if (this.proj.seeThrough) return true;
    const w = this.w;
    this.a.set(w[0]!, w[1]!, w[2]!);
    this.b.set(w[3]!, w[4]!, w[5]!);
    this.c.set(w[6]!, w[7]!, w[8]!);
    this.ab.subVectors(this.b, this.a);
    this.ac.subVectors(this.c, this.a);
    this.nrm.crossVectors(this.ab, this.ac);
    this.look.copy(this.proj.ortho ? this.proj.camDir : this.a.sub(this.proj.camPos));
    return this.nrm.dot(this.look) < 0;
  }
}

function clusterRange(b: BodyArea, f: number, c: number): [ArrayLike<number>, number, number] {
  const seq = b.idx.order[f] ?? (b.idx.faceTris[f] as number[]);
  const last = (b.idx.firstCluster[f + 1] as number) - 1;
  return [seq, b.idx.clusterStart[c] as number, c < last ? (b.idx.clusterStart[c + 1] as number) : seq.length];
}

function hasFacing(b: BodyArea, f: number, c: number, probe: TriProbe, seeThrough: boolean): boolean {
  if (b.facing[c] === 0) {
    let any = false;
    const [seq, from, to] = clusterRange(b, f, c);
    if (seeThrough) any = to > from;
    else
      for (let s = from; s < to && !any; s++) {
        probe.load(b, seq[s] as number);
        any = probe.facing();
      }
    b.facing[c] = any ? 1 : 2;
  }
  return b.facing[c] === 1;
}

/** "in" every point inside the box, "out" none, "cut" to be settled triangle by triangle. */
function clusterSide(b: BodyArea, c: number, r: ScreenRect): "in" | "out" | "cut" {
  const x0 = b.screen[c * 4] as number;
  if (Number.isNaN(x0)) return "cut";
  const y0 = b.screen[c * 4 + 1] as number,
    x1 = b.screen[c * 4 + 2] as number,
    y1 = b.screen[c * 4 + 3] as number;
  if (x0 >= r.x0 + SLACK_PX && y0 >= r.y0 + SLACK_PX && x1 <= r.x1 - SLACK_PX && y1 <= r.y1 - SLACK_PX) return "in";
  if (x0 > r.x1 + SLACK_PX || x1 < r.x0 - SLACK_PX || y0 > r.y1 + SLACK_PX || y1 < r.y0 - SLACK_PX) return "out";
  return "cut";
}

/** Window: every facing triangle inside, and at least one. `failed` when a facing triangle is not. */
function faceWindow(b: BodyArea, f: number, r: ScreenRect, probe: TriProbe, see: boolean) {
  let facing = false;
  const end = b.idx.firstCluster[f + 1] as number;
  for (let c = b.idx.firstCluster[f] as number; c < end; c++) {
    const side = clusterSide(b, c, r);
    if (side === "in") {
      if (!facing) facing = hasFacing(b, f, c, probe, see);
      continue;
    }
    if (side === "out") {
      if (hasFacing(b, f, c, probe, see)) return { taken: false, failed: true };
      continue;
    }
    if (b.facing[c] === 2) continue;
    const [seq, from, to] = clusterRange(b, f, c);
    for (let s = from; s < to; s++) {
      probe.load(b, seq[s] as number);
      if (!probe.facing()) continue;
      facing = true;
      if (!allInsideRect(probe.s, r)) return { taken: false, failed: true };
    }
  }
  return { taken: facing, failed: false };
}

/** Crossing: any facing triangle touched. */
function faceCrossing(b: BodyArea, f: number, r: ScreenRect, probe: TriProbe, see: boolean): boolean {
  const end = b.idx.firstCluster[f + 1] as number;
  for (let c = b.idx.firstCluster[f] as number; c < end; c++) {
    const side = clusterSide(b, c, r);
    if (side === "out") continue;
    if (side === "in") {
      if (hasFacing(b, f, c, probe, see)) return true;
      continue;
    }
    if (b.facing[c] === 2) continue;
    const [seq, from, to] = clusterRange(b, f, c);
    for (let s = from; s < to; s++) {
      probe.load(b, seq[s] as number);
      if (probe.facing() && convexTouchesRect(probe.s, r)) return true;
    }
  }
  return false;
}

/** A window takes a body only when all of it is inside, a crossing as soon as
 *  one face is touched, so a window over an assembly leaves the plate behind. */
export function collectInBox(
  proj: AreaProjection,
  rect: ScreenRect,
  mode: AreaMode,
): {
  faces: number[];
  edges: EdgeRef[];
  bodies: string[];
} {
  const out = { faces: [] as number[], edges: [] as EdgeRef[], bodies: [] as string[] };
  const probe = new TriProbe(proj);
  const see = proj.seeThrough;
  for (const b of proj.bodies) {
    let touched = false;
    let anyFacing = false;
    let anyFailed = false;
    for (let f = 0; f < b.faceIds.length; f++) {
      let hit: boolean;
      if (mode === "window") {
        const w = faceWindow(b, f, rect, probe, see);
        hit = w.taken;
        if (w.taken) anyFacing = true;
        if (w.failed) anyFailed = true;
      } else hit = faceCrossing(b, f, rect, probe, see);
      if (!hit) continue;
      out.faces.push(b.faceIds[f] as number);
      touched = true;
    }
    const whole = mode === "window" ? anyFacing && !anyFailed : touched;
    if (whole) out.bodies.push(b.id);
  }
  for (const e of proj.edges) {
    if (e.flat === null) continue;
    const quick = boxVerdict(e.box, rect, mode);
    if (quick === "look" ? polylineInBox(e.flat, rect, mode) : quick) out.edges.push(e.ref);
  }
  return out;
}
