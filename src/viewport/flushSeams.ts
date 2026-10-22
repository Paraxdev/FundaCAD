// Display only: hides an edge where two distinct coplanar, same orientation planar faces sit on opposite sides of it,
// checked on the triangles so a hole rim never hides. Past FLUSH_SEAM_MAX_EDGES it is skipped, and sceneStats says so.

import * as THREE from "three";
import { edgeObjects, type BodyMesh, type ModelView } from "./render";

// Superlinear, measured (evals/harness/seam_cost.cjs): 0.8 us an edge at 2,000 edges, 6.7 at 20,000, 17.2 at 40,000,
// over 60% of setModel past the cap. An imported assembly that large wants its part boundaries seen anyway.
export const FLUSH_SEAM_MAX_EDGES = 20_000;

/** Hide the seams on `model`, and say what it cost. */
export function hideFlushSeams(model: ModelView | null): { ms: number; skipped: boolean } {
  const t0 = performance.now();
  if (!model) return { ms: 0, skipped: false };
  if (model.edges.length > FLUSH_SEAM_MAX_EDGES) {
    return { ms: performance.now() - t0, skipped: true };
  }
  try {
    hideSeams(model);
  } finally {
    // measured either way: a pass that threw still spent the time
  }
  return { ms: performance.now() - t0, skipped: false };
}

function hideSeams(model: ModelView) {
  if (!model.edges.length) return;

  // faceId is unique across bodies (the wire protocol partitions it), so one Map spans the model and a seam between two
  // mating bodies hides too. Curved faces never hide a seam.
  interface FInfo {
    planar: boolean;
    n: THREE.Vector3;
    p: THREE.Vector3;
    min: THREE.Vector3;
    max: THREE.Vector3;
    tris: { body: BodyMesh; t: number }[]; // (owning body, LOCAL triangle index)
  }
  const faces = new Map<number, FInfo>();
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3();
  const ab = new THREE.Vector3(),
    ac = new THREE.Vector3(),
    n = new THREE.Vector3();
  for (const body of model.bodies) {
    const pos = body.mesh.geometry.getAttribute("position");
    const index = body.mesh.geometry.getIndex()!;
    const ids = body.faceIds;
    const mw = body.mesh.matrixWorld;
    for (let t = 0; t < ids.length; t++) {
      a.fromBufferAttribute(pos, index.getX(t * 3)).applyMatrix4(mw);
      b.fromBufferAttribute(pos, index.getX(t * 3 + 1)).applyMatrix4(mw);
      c.fromBufferAttribute(pos, index.getX(t * 3 + 2)).applyMatrix4(mw);
      n.copy(ab.copy(b).sub(a)).cross(ac.copy(c).sub(a));
      const len = n.length();
      const id = ids[t];
      if (id === undefined) continue;
      let f = faces.get(id);
      if (!f) {
        f = {
          planar: true,
          n: len > 1e-9 ? n.clone().divideScalar(len) : new THREE.Vector3(),
          p: a.clone(),
          min: a.clone(),
          max: a.clone(),
          tris: [],
        };
        faces.set(id, f);
      } else if (len > 1e-9 && f.n.lengthSq() > 0.5 && n.clone().divideScalar(len).dot(f.n) < 0.9998) {
        f.planar = false;
      } else if (len > 1e-9 && f.n.lengthSq() < 0.5) {
        f.n.copy(n).divideScalar(len);
      }
      f.tris.push({ body, t });
      for (const v of [a, b, c]) {
        f.min.min(v);
        f.max.max(v);
      }
    }
  }

  const TOL = 0.02; // on-plane tolerance (mm), flush contacts are exact
  const INFL = 0.5; // bbox slack for candidate gathering
  const EPS = 0.3; // side-sample offset from the edge (mm)
  const planar = [...faces.values()].filter((f) => f.planar && f.n.lengthSq() > 0.5);

  const tri = new THREE.Triangle();
  const closest = new THREE.Vector3();
  const contains = (f: FInfo, q: THREE.Vector3) => {
    if (
      q.x < f.min.x - EPS ||
      q.x > f.max.x + EPS ||
      q.y < f.min.y - EPS ||
      q.y > f.max.y + EPS ||
      q.z < f.min.z - EPS ||
      q.z > f.max.z + EPS
    )
      return false;
    for (const { body, t } of f.tris) {
      const pos = body.mesh.geometry.getAttribute("position");
      const index = body.mesh.geometry.getIndex()!;
      const mw = body.mesh.matrixWorld;
      tri.a.fromBufferAttribute(pos, index.getX(t * 3)).applyMatrix4(mw);
      tri.b.fromBufferAttribute(pos, index.getX(t * 3 + 1)).applyMatrix4(mw);
      tri.c.fromBufferAttribute(pos, index.getX(t * 3 + 2)).applyMatrix4(mw);
      tri.closestPointToPoint(q, closest);
      if (closest.distanceTo(q) < 0.05) return true;
    }
    return false;
  };

  const lo = new THREE.Vector3(),
    hi = new THREE.Vector3();
  const m = new THREE.Vector3(),
    d = new THREE.Vector3(),
    s = new THREE.Vector3();
  const qPlus = new THREE.Vector3(),
    qMinus = new THREE.Vector3();
  for (const line of model.edges) {
    const pts = line.points;
    if (!pts || pts.length < 2) continue;
    lo.set(Infinity, Infinity, Infinity);
    hi.set(-Infinity, -Infinity, -Infinity);
    for (const q of pts) {
      lo.x = Math.min(lo.x, q[0]);
      lo.y = Math.min(lo.y, q[1]);
      lo.z = Math.min(lo.z, q[2]);
      hi.x = Math.max(hi.x, q[0]);
      hi.y = Math.max(hi.y, q[1]);
      hi.z = Math.max(hi.z, q[2]);
    }
    // candidate faces: planar, edge lies in their plane, bbox borders the edge
    const cands: FInfo[] = [];
    for (const f of planar) {
      if (
        f.min.x - INFL > lo.x ||
        f.max.x + INFL < hi.x ||
        f.min.y - INFL > lo.y ||
        f.max.y + INFL < hi.y ||
        f.min.z - INFL > lo.z ||
        f.max.z + INFL < hi.z
      )
        continue;
      let on = true;
      for (const q of pts) {
        const dd = (q[0] - f.p.x) * f.n.x + (q[1] - f.p.y) * f.n.y + (q[2] - f.p.z) * f.n.z;
        if (Math.abs(dd) > TOL) {
          on = false;
          break;
        }
      }
      if (on) cands.push(f);
    }
    if (cands.length < 2) continue;
    const c0 = cands[0];
    if (!c0) continue;

    // side samples at the edge midpoint, perpendicular to the edge IN the plane
    const k = Math.floor((pts.length - 1) / 2);
    const pk = pts[k],
      pk1 = pts[k + 1];
    if (!pk || !pk1) continue;
    m.set((pk[0] + pk1[0]) / 2, (pk[1] + pk1[1]) / 2, (pk[2] + pk1[2]) / 2);
    d.set(pk1[0] - pk[0], pk1[1] - pk[1], pk1[2] - pk[2]);
    if (d.lengthSq() < 1e-12) continue;
    d.normalize();
    s.crossVectors(d, c0.n).normalize();
    qPlus.copy(m).addScaledVector(s, EPS);
    qMinus.copy(m).addScaledVector(s, -EPS);

    // the surface continues across iff DISTINCT same-orientation faces own
    // the two sides (one face owning both = the edge wraps a slot/hole rim)
    let gPlus: FInfo | null = null;
    let gMinus: FInfo | null = null;
    for (const f of cands)
      if (contains(f, qPlus)) {
        gPlus = f;
        break;
      }
    for (const f of cands)
      if (contains(f, qMinus)) {
        gMinus = f;
        break;
      }
    if (gPlus && gMinus && gPlus !== gMinus && gPlus.n.dot(gMinus.n) > 0.999) {
      line.draw.setHidden(line.slot, true);
    }
  }
  // hiding is a geometry rebuild, so batch it: one flush per body, not one
  // per hidden edge (this loop hides thousands on an imported assembly).
  for (const draw of edgeObjects(model)) draw.flush();
}
