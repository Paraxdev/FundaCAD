// The model projected to the screen for a box drag. Every face keeps its screen
// bounding box, which settles a window outright and rules most of the model out
// for a crossing, so only a crossing that really overlaps walks triangles.

import * as THREE from "three";
import type { EdgeRef, ModelView } from "./render";
import {
  boxOf,
  boxVerdict,
  faceInBox,
  polylineInBox,
  unionBox,
  type AreaMode,
  type ScreenBox,
  type ScreenRect,
} from "./areaSelect";

export interface AreaProjection {
  bodies: {
    id: string;
    box: ScreenBox;
    faces: { faceId: number; tris: number[][]; box: ScreenBox }[];
  }[];
  edges: { ref: EdgeRef; flat: number[] | null; box: ScreenBox }[];
}

/** `seeThrough` keeps the far side: without it back-facing triangles are culled. */
export function projectForArea(model: ModelView, cam: THREE.Camera, view: DOMRect, seeThrough: boolean): AreaProjection {
  const out: AreaProjection = { bodies: [], edges: [] };
  cam.updateMatrixWorld();
  const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const ortho = (cam as THREE.OrthographicCamera).isOrthographicCamera === true;
  const camDir = cam.getWorldDirection(new THREE.Vector3());
  const camPos = cam.position;

  const tri: number[] = [0, 0, 0, 0, 0, 0];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const look = new THREE.Vector3();

  for (const body of model.bodies) {
    if (!body.mesh.visible) continue;
    const geom = body.mesh.geometry;
    const pos = geom.getAttribute("position");
    const index = geom.getIndex();
    if (!pos || !index) continue;
    const count = pos.count;
    // Per vertex, not per triangle: a closed solid shares each vertex between triangles.
    const sx = new Float64Array(count);
    const sy = new Float64Array(count);
    const wx = new Float64Array(count);
    const wy = new Float64Array(count);
    const wz = new Float64Array(count);
    const p = new THREE.Vector4();
    for (let i = 0; i < count; i++) {
      p.set(pos.getX(i), pos.getY(i), pos.getZ(i), 1).applyMatrix4(body.mesh.matrixWorld);
      wx[i] = p.x; wy[i] = p.y; wz[i] = p.z;
      p.applyMatrix4(vp);
      // Behind the camera the divide folds a point back into view. NaN answers
      // no to both verdicts in areaSelect.
      if (!(p.w > 0)) { sx[i] = NaN; sy[i] = NaN; continue; }
      sx[i] = view.left + ((p.x / p.w) * 0.5 + 0.5) * view.width;
      sy[i] = view.top + ((-p.y / p.w) * 0.5 + 0.5) * view.height;
    }

    const faces: { faceId: number; tris: number[][]; box: ScreenBox }[] = [];
    let bodyBox: ScreenBox = [Infinity, Infinity, -Infinity, -Infinity];
    let anyFace = false;
    for (const [faceId, tris] of body.faceTriangles) {
      const facing: number[][] = [];
      for (const t of tris) {
        const i0 = index.getX(t * 3);
        const i1 = index.getX(t * 3 + 1);
        const i2 = index.getX(t * 3 + 2);
        if (!seeThrough) {
          a.set(wx[i0] as number, wy[i0] as number, wz[i0] as number);
          b.set(wx[i1] as number, wy[i1] as number, wz[i1] as number);
          c.set(wx[i2] as number, wy[i2] as number, wz[i2] as number);
          ab.subVectors(b, a);
          ac.subVectors(c, a);
          nrm.crossVectors(ab, ac);
          look.copy(ortho ? camDir : a.sub(camPos));
          if (nrm.dot(look) >= 0) continue;
        }
        tri[0] = sx[i0] as number; tri[1] = sy[i0] as number;
        tri[2] = sx[i1] as number; tri[3] = sy[i1] as number;
        tri[4] = sx[i2] as number; tri[5] = sy[i2] as number;
        facing.push(tri.slice());
      }
      let box: ScreenBox = facing.length ? [Infinity, Infinity, -Infinity, -Infinity] : null;
      for (const t of facing) box = unionBox(box, boxOf(t));
      faces.push({ faceId, tris: facing, box });
      if (facing.length) {
        anyFace = true;
        bodyBox = unionBox(bodyBox, box);
      }
    }
    out.bodies.push({ id: body.id, box: anyFace ? bodyBox : null, faces });
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
      if (!(q.w > 0)) { usable = false; break; }
      flat.push(
        view.left + ((q.x / q.w) * 0.5 + 0.5) * view.width,
        view.top + ((-q.y / q.w) * 0.5 + 0.5) * view.height,
      );
    }
    out.edges.push(usable ? { ref: e, flat, box: boxOf(flat) } : { ref: e, flat: null, box: null });
  }
  return out;
}

/** A window takes a body only when all of it is inside, a crossing as soon as
 *  one face is touched, so a window over an assembly leaves the plate behind. */
export function collectInBox(proj: AreaProjection, rect: ScreenRect, mode: AreaMode): {
  faces: number[];
  edges: EdgeRef[];
  bodies: string[];
} {
  const out = { faces: [] as number[], edges: [] as EdgeRef[], bodies: [] as string[] };
  for (const body of proj.bodies) {
    let touched = false;
    for (const face of body.faces) {
      const quick = boxVerdict(face.box, rect, mode);
      if (!(quick === "look" ? faceInBox(face.tris, rect, mode) : quick)) continue;
      out.faces.push(face.faceId);
      touched = true;
    }
    const whole = mode === "window" ? boxVerdict(body.box, rect, "window") === true : touched;
    if (whole) out.bodies.push(body.id);
  }
  for (const e of proj.edges) {
    if (e.flat === null) continue;
    const quick = boxVerdict(e.box, rect, mode);
    if (quick === "look" ? polylineInBox(e.flat, rect, mode) : quick) out.edges.push(e.ref);
  }
  return out;
}
