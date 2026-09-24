// The previews a drag paints before the kernel has said anything.
//
// Split out of viewport.ts. Every one of these is the same bargain: a rebuild
// through the engine is exact and takes long enough that a drag would lurch,
// so the frontend draws what the result is going to be and the real feature is
// committed on release. Nothing here ever reaches the document.
//
// Four of them, and they are different KINDS of cheat:
//
//   - press/pull builds new geometry (a prism raised off the picked faces), so
//     it is a mesh of its own that is thrown away on commit;
//   - a move touches no geometry at all, a rigid transform is a matrix on the
//     body objects, zero vertex writes, and picking follows it because raycasts
//     read matrixWorld;
//   - a pattern is the move trick N times over, drawn as cloned meshes.
//   - a fillet/chamfer sweeps an approximate wedge along the picked edges from
//     the mesh's own triangles, since (unlike press/pull) the real result isn't
//     a simple offset of anything already on screen; features/blendGhost.ts has
//     the geometry, this only supplies the edges' points and adjacent-face
//     normals it needs and turns the answer into a mesh.
//
// The move ghost is the one with a real hand-off: on commit the offset STAYS
// until the rebuilt body arrives, because dropping it would snap the part back
// for the frame or two the round trip takes.

import * as THREE from "three";
import { radialAt } from "../features/planeMath";
import type { RoundFace } from "../features/radialDrag";
import { sweepBlendGhost, type BlendKind, type EdgeSample, type Pt3 } from "../features/blendGhost";
import { bodyOfFace, type BodyEdges, type BodyMesh, type ModelView } from "./render";
import { themeColor } from "./themeColors";

/** The slice of Viewport these previews need, live accessors, not copies. */
export interface GhostHost {
  /** the current model, or null between builds */
  model(): ModelView | null;
  addToScene(obj: THREE.Object3D): void;
  removeFromScene(obj: THREE.Object3D): void;
  requestRender(): void;
  /** a picked face's outward normal in world space, for the flat press/pull */
  faceNormalWorld(faceId: number): THREE.Vector3;
}

/** One picked edge as the blend ghost needs it: structural, like
 *  blendClearance.ts's ClearanceEdge, so a caller can hand over its own
 *  EdgeRef/GhostEdge without importing viewport/edgeLines.ts here. */
export interface BlendGhostEdge {
  readonly body: string | undefined;
  readonly points: readonly Pt3[];
}

export class GhostLayer {
  constructor(private host: GhostHost) {}

  // --- Press/Pull ghost: an instant frontend-only preview of the extrude so the
  // drag feels immediate (the real OCCT result needs a full rebuild and only lands
  // on commit). For each selected face we offset its triangles by distance·normal
  // (the cap) and raise walls from the face's boundary edges → a translucent prism.
  private ppGhost: THREE.Mesh | null = null;
  /** `round` makes the offset RADIAL and per-vertex instead of one constant
   *  vector: a resized cylinder is not a translated one, and its face normal is
   *  the average that cancels to nothing anyway. `distance` is then the outward
   *  radial delta (bigger = away from the axis), not the kernel's signed push. */
  setPressPullGhost(faceIds: number[], distance: number, round?: RoundFace | null) {
    this.clearPressPullGhost();
    const model = this.host.model();
    if (!model || faceIds.length === 0 || Math.abs(distance) < 1e-4) return;
    const out: number[] = [];
    const push = (v: THREE.Vector3) => out.push(v.x, v.y, v.z);
    for (const faceId of faceIds) {
      // per-body model: resolve the face's owning body and read its own buffers
      // (vertex indices below are body-local, consistent with wv()'s source).
      const body = bodyOfFace(model, faceId);
      const triIdx = body?.faceTriangles.get(faceId);
      if (!body || !triIdx || triIdx.length === 0) continue;
      const pos = body.mesh.geometry.getAttribute("position");
      const index = body.mesh.geometry.getIndex()!;
      const mw = body.mesh.matrixWorld;
      const wv = (vi: number) => new THREE.Vector3().fromBufferAttribute(pos, vi).applyMatrix4(mw);
      const flat = round ? null : this.host.faceNormalWorld(faceId).multiplyScalar(distance);
      const moved = (v: THREE.Vector3) => {
        if (flat) return v.clone().add(flat);
        const r = round && radialAt(round.cylinder, [v.x, v.y, v.z]);
        return r ? v.clone().addScaledVector(new THREE.Vector3(r[0], r[1], r[2]), distance) : v.clone();
      };
      const tris: [number, number, number][] = triIdx.map(
        (t) => [index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2)] as [number, number, number],
      );
      // cap (the face at its new size / position)
      for (const [i0, i1, i2] of tris) {
        push(moved(wv(i0))); push(moved(wv(i1))); push(moved(wv(i2)));
      }
      // boundary walls: an edge interior to the face appears in two triangles
      // (toggled out); a boundary edge appears once (kept).
      const edges = new Map<string, [number, number]>();
      const bump = (a: number, b: number) => {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, [a, b]);
      };
      for (const [i0, i1, i2] of tris) { bump(i0, i1); bump(i1, i2); bump(i2, i0); }
      for (const [a, b] of edges.values()) {
        const A = wv(a), B = wv(b);
        const Ao = moved(A), Bo = moved(B);
        push(A); push(B); push(Bo);
        push(A); push(Bo); push(Ao);
      }
    }
    if (!out.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
    const mat = new THREE.MeshBasicMaterial({
      color: distance >= 0 ? 0xffc83d : 0xff6b5c, // amber = add, red = cut
      transparent: true,
      // A cut is seen through its ghosted body, so it is drawn the stronger.
      opacity: distance >= 0 ? 0.4 : 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ppGhost = new THREE.Mesh(geo, mat);
    this.ppGhost.renderOrder = 998;
    this.host.addToScene(this.ppGhost);
    this.host.requestRender();
  }
  clearPressPullGhost() {
    if (!this.ppGhost) return;
    this.host.removeFromScene(this.ppGhost);
    this.ppGhost.geometry.dispose();
    (this.ppGhost.material as THREE.Material).dispose();
    this.ppGhost = null;
    this.host.requestRender();
  }

  // --- Fillet/chamfer ghost: an instant approximation of the blend so a radius/
  // distance drag reads live instead of waiting on OCCT. Unlike press/pull, a
  // blend isn't a simple offset of a picked face, it depends on the two faces
  // that meet at the edge, so this samples the ALREADY-DISPLAYED mesh around
  // each picked edge for those two faces' normals and hands the geometry to
  // features/blendGhost.ts, which sweeps the wedge. An edge whose normals can't
  // be pinned down (a seam, a T-junction, two faces meeting almost flat) is
  // simply left out rather than drawn wrong, see edgeFaceSamples.
  private blendGhostMesh: THREE.Mesh | null = null;

  setBlendGhost(edges: readonly BlendGhostEdge[], size: number, kind: BlendKind) {
    this.clearBlendGhost();
    const model = this.host.model();
    if (!model || !edges.length || size < 1e-4) return;
    const positions: number[] = [];
    for (const edge of edges) {
      const samples = edgeFaceSamples(model, edge);
      if (!samples) continue; // can't tell the two faces apart here, skip THIS edge
      const geo = sweepBlendGhost(samples, size, kind);
      if (geo) positions.push(...geo.positions);
    }
    if (!positions.length) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color: themeColor("--accent", 0xff7a3c),
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
      // The wedge previews material about to be CUT AWAY, so it always sits
      // behind the sharp corner it is replacing, depth-tested against the
      // solid it is still part of. Normal depth testing would hide it
      // completely rather than show it through, so it is off here.
      depthTest: false,
    });
    this.blendGhostMesh = new THREE.Mesh(geom, mat);
    this.blendGhostMesh.renderOrder = 998;
    this.host.addToScene(this.blendGhostMesh);
    this.host.requestRender();
  }
  clearBlendGhost() {
    if (!this.blendGhostMesh) return;
    this.host.removeFromScene(this.blendGhostMesh);
    this.blendGhostMesh.geometry.dispose();
    (this.blendGhostMesh.material as THREE.Material).dispose();
    this.blendGhostMesh = null;
    this.host.requestRender();
  }

  // --- Move ghost: translate the selected bodies' mesh + edges live during a drag,
  // with NO engine rebuild (a rigid move needs no geometry recompute), so dragging
  // is snappy. The real `move` feature is committed on release. With per-body meshes
  // this is a pure object-transform offset: zero vertex writes, zero GPU uploads.
  // Raycasts (bodyIdAt, pointInSolid parity) follow matrixWorld, refreshed eagerly
  // on every offset so picking never lags the visual. On commit (restore=false) the
  // offset stays until the rebuilt body arrives; the moved body's etag changes, so
  // setModel replaces its mesh (position 0), and resetBodyAppearance() clears any
  // lingering offset on the reuse path as a belt-and-braces guard.
  private moveGhost: {
    bodies: BodyMesh[];
    edges: BodyEdges[];
  } | null = null;
  beginBodyMoveGhost(bodyIds: string[]) {
    this.endBodyMoveGhost(true);
    const model = this.host.model();
    if (!model) return;
    const sel = new Set(bodyIds);
    const bodies = model.bodies.filter((b) => sel.has(b.id));
    if (!bodies.length) return;
    const edges = bodies.map((b) => b.edges);
    this.moveGhost = { bodies, edges };
  }
  setBodyMoveOffset(offset: THREE.Vector3) {
    this.setBodyMoveTransform(new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z));
  }

  /** The ghost under a FULL transform, so the gizmo's rotation is previewed the
   *  same way its translation always was.
   *
   *  Decomposed onto the objects rather than assigned as a matrix, because the
   *  mesh and its edges keep matrixAutoUpdate on and would overwrite one. The
   *  scale component is carried too: an assembly imported at a non-unit scale
   *  has it in matrixWorld already, and dropping it here would make the ghost
   *  the wrong size for exactly those documents. */
  setBodyMoveTransform(m: THREE.Matrix4) {
    if (!this.moveGhost || !this.host.model()) return;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    m.decompose(pos, quat, scl);
    for (const b of this.moveGhost.bodies) {
      b.mesh.position.copy(pos);
      b.mesh.quaternion.copy(quat);
      b.mesh.scale.copy(scl);
      b.mesh.updateMatrixWorld();
    }
    for (const e of this.moveGhost.edges) {
      e.object.position.copy(pos);
      e.object.quaternion.copy(quat);
      e.object.scale.copy(scl);
    }
    this.host.requestRender();
  }
  // --- Pattern ghosts: translucent copies of a body, one per pattern cell -----
  //
  // The copies share the source body's geometry buffers, a ghost is a second
  // draw of the same vertices, so twenty of them cost twenty draw calls and no
  // memory. Rebuilt only when the SET changes (a different body, a different
  // count); a drag that only moves the copies rewrites matrices.
  //
  // Ghosts rather than a live rebuild, for the same reason the move ghost
  // exists: a pattern is a rigid repeat, its copies are known exactly on this
  // side, and asking the kernel to union twenty solids per frame of a drag would
  // make the drag unusable to show something the drag already knows.
  private ghosts: { key: string; copies: THREE.Group[] } | null = null;
  private patternGhostMat: THREE.MeshBasicMaterial | null = null;

  setPatternGhost(bodyIds: readonly string[], matrices: readonly THREE.Matrix4[]) {
    const key = `${bodyIds.join(",")}|${matrices.length}`;
    if (!this.ghosts || this.ghosts.key !== key) {
      this.clearPatternGhost();
      const model = this.host.model();
      if (!model || !bodyIds.length || !matrices.length) return;
      const sel = new Set(bodyIds);
      const src = model.bodies.filter((b) => sel.has(b.id));
      if (!src.length) return;
      this.patternGhostMat ??= new THREE.MeshBasicMaterial({
        color: themeColor("--accent", 0xff7a3c),
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const copies: THREE.Group[] = [];
      // Copy 0 is the original and is already on screen: ghosting it would only
      // tint the body you can see. The matrices still include it, so the indices
      // line up with the pattern's own numbering.
      for (let i = 1; i < matrices.length; i++) {
        const g = new THREE.Group();
        g.matrixAutoUpdate = false;
        for (const b of src) g.add(new THREE.Mesh(b.mesh.geometry, this.patternGhostMat));
        g.renderOrder = 1;
        copies.push(g);
        this.host.addToScene(g);
      }
      this.ghosts = { key, copies };
    }
    for (let i = 0; i < this.ghosts.copies.length; i++) {
      const g = this.ghosts.copies[i];
      const m = matrices[i + 1];
      if (g && m) {
        g.matrix.copy(m);
        g.updateMatrixWorld(true);
      }
    }
    this.host.requestRender();
  }

  clearPatternGhost() {
    if (this.ghosts) {
      for (const g of this.ghosts.copies) {
        this.host.removeFromScene(g);
        // The geometry belongs to the body and the material is shared; disposing
        // either here would blank the model the ghosts were copied from.
        g.clear();
      }
      this.ghosts = null;
    }
    this.patternGhostMat?.dispose();
    this.patternGhostMat = null;
    this.host.requestRender();
  }

  endBodyMoveGhost(restore: boolean) {
    if (!this.moveGhost || !this.host.model()) {
      this.moveGhost = null;
      return;
    }
    if (restore) {
      for (const b of this.moveGhost.bodies) {
        b.mesh.position.set(0, 0, 0);
        b.mesh.quaternion.identity();
        b.mesh.scale.set(1, 1, 1);
        b.mesh.updateMatrixWorld();
      }
      for (const e of this.moveGhost.edges) {
        e.object.position.set(0, 0, 0);
        e.object.quaternion.identity();
        e.object.scale.set(1, 1, 1);
      }
      this.host.requestRender();
    }
    this.moveGhost = null;
  }
}

// --- blend ghost support: which two faces meet an edge, read off the mesh ---
//
// The wire protocol never says which faces border an edge, so this asks the
// already-tessellated mesh instead. The edge polyline and the body's own
// triangulation are two SEPARATE discretization passes though: a polyline
// point is not, in general, also a mesh vertex (real gaps run 0.8-1.4mm), and
// a straight edge's polyline is just its two endpoints, which are corners
// where three faces meet. So rather than looking a point up as a vertex, this
// resamples the edge at points strictly BETWEEN its ends (never a corner) and
// finds each one's two adjacent faces by nearest triangle, one per faceId,
// within a tolerance derived from the mesh's own tessellation density.

/** One triangle of a body's mesh, local space, with its outward geometric
 *  normal precomputed (same winding faceNormalWorld relies on: no flip). */
interface TriRec {
  faceId: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  normal: THREE.Vector3;
  centroid: THREE.Vector3;
}

/** A uniform hash grid of a body's triangles, bucketed by centroid, cell size
 *  set from the mesh's own average edge length so a coarse body gets coarse
 *  cells and a finely tessellated one gets fine cells. `tolerance` is how far
 *  a sample point may sit from the nearest triangle and still count as "on"
 *  that face: a few triangle-edges' worth, floored so a degenerate/near-empty
 *  mesh doesn't collapse it to zero. */
interface TriGrid {
  cellSize: number;
  tolerance: number;
  cells: Map<string, TriRec[]>;
}

const triGridCache = new WeakMap<BodyMesh, TriGrid>();

function cellKey(x: number, y: number, z: number, cellSize: number): string {
  return `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;
}

function buildTriGrid(body: BodyMesh): TriGrid {
  const pos = body.mesh.geometry.getAttribute("position");
  const index = body.mesh.geometry.getIndex();
  const triCount = index ? index.count / 3 : 0;
  const recs: TriRec[] = [];
  let edgeLenSum = 0, edgeLenCount = 0;
  if (pos && index) {
    for (let t = 0; t < triCount; t++) {
      const fid = body.faceIds[t];
      if (fid === undefined) continue;
      const a = new THREE.Vector3().fromBufferAttribute(pos, index.getX(t * 3));
      const b = new THREE.Vector3().fromBufferAttribute(pos, index.getX(t * 3 + 1));
      const c = new THREE.Vector3().fromBufferAttribute(pos, index.getX(t * 3 + 2));
      const normal = b.clone().sub(a).cross(c.clone().sub(a)); // area-weighted, see faceNormalWorld
      const len = normal.length();
      if (len < 1e-12) continue; // degenerate triangle
      normal.divideScalar(len);
      const centroid = a.clone().add(b).add(c).divideScalar(3);
      recs.push({ faceId: fid, a, b, c, normal, centroid });
      edgeLenSum += a.distanceTo(b) + b.distanceTo(c) + c.distanceTo(a);
      edgeLenCount += 3;
    }
  }
  const avgEdge = edgeLenCount ? edgeLenSum / edgeLenCount : 1;
  const cellSize = Math.max(avgEdge, 1e-3);
  const tolerance = Math.max(avgEdge * 3, 0.05);
  const cells = new Map<string, TriRec[]>();
  for (const r of recs) {
    const key = cellKey(r.centroid.x, r.centroid.y, r.centroid.z, cellSize);
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(r);
  }
  return { cellSize, tolerance, cells };
}

function triGrid(body: BodyMesh): TriGrid {
  let g = triGridCache.get(body);
  if (!g) {
    g = buildTriGrid(body);
    triGridCache.set(body, g);
  }
  return g;
}

const scratchTri = new THREE.Triangle();
const scratchClosest = new THREE.Vector3();

/** The two faces' outward normals nearest one point on an edge, or null when
 *  fewer than two distinct faces have a triangle within tolerance. Per
 *  faceId, only the closest triangle's normal counts, a curved face's normal
 *  turns along the edge so its nearest triangle is the right one to ask (see
 *  faceNormalWorld for the whole-face average used elsewhere). */
function facesAtPoint(body: BodyMesh, p: Pt3): { faceIds: [number, number]; normals: [THREE.Vector3, THREE.Vector3] } | null {
  const grid = triGrid(body);
  if (!grid.cells.size) return null;
  const pv = new THREE.Vector3(p[0], p[1], p[2]);
  const cs = grid.cellSize;
  const cx = Math.floor(pv.x / cs), cy = Math.floor(pv.y / cs), cz = Math.floor(pv.z / cs);
  // tolerance is ~3 cells by construction (see buildTriGrid), +1 cell of slack
  // for a sample that lands near a cell boundary.
  const reach = Math.max(1, Math.ceil(grid.tolerance / cs)) + 1;
  const byFace = new Map<number, { dist: number; normal: THREE.Vector3 }>();
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const list = grid.cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!list) continue;
        for (const t of list) {
          scratchTri.set(t.a, t.b, t.c);
          scratchTri.closestPointToPoint(pv, scratchClosest);
          const dist = scratchClosest.distanceTo(pv);
          if (dist > grid.tolerance) continue;
          const prev = byFace.get(t.faceId);
          if (!prev || dist < prev.dist) byFace.set(t.faceId, { dist, normal: t.normal });
        }
      }
    }
  }
  if (byFace.size < 2) return null;
  const nearest = [...byFace.entries()].sort((a, b) => a[1].dist - b[1].dist).slice(0, 2);
  return {
    faceIds: [nearest[0]![0], nearest[1]![0]],
    normals: [nearest[0]![1].normal.clone(), nearest[1]![1].normal.clone()],
  };
}

/** `count` points along an edge polyline, evenly spaced by arc length,
 *  inset from both ends so a straight edge's two corner points (where a
 *  third face joins in) are never sampled. Null on a degenerate (zero-length,
 *  single-point) polyline. */
function resampleEdge(pts: readonly Pt3[], count: number): Pt3[] | null {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0, z0] = pts[i - 1]!, [x1, y1, z1] = pts[i]!;
    cum.push(cum[i - 1]! + Math.hypot(x1 - x0, y1 - y0, z1 - z0));
  }
  const total = cum[cum.length - 1]!;
  if (total < 1e-9) return null;
  const inset = total * 0.04;
  const span = total - inset * 2;
  if (span <= 0) return null;
  const out: Pt3[] = [];
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const target = inset + (count === 1 ? 0.5 : i / (count - 1)) * span;
    while (seg < cum.length - 2 && cum[seg + 1]! < target) seg++;
    const segLen = cum[seg + 1]! - cum[seg]!;
    const t = segLen > 1e-12 ? (target - cum[seg]!) / segLen : 0;
    const a = pts[seg]!, b = pts[seg + 1]!;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  return out;
}

/** Between 12 and 24 resample points: more for an edge whose own polyline
 *  already carries more detail (a curved edge), never fewer than 12. */
function sampleCount(polylineLen: number): number {
  return Math.min(24, Math.max(12, polylineLen));
}

/** An edge is still drawable with some samples missing; below this many the
 *  ribbon would be too sparse to read as a fillet, so the whole edge is
 *  dropped instead (sweepBlendGhost also refuses fewer than 2). */
const MIN_VALID_SAMPLES = 4;

/** A picked edge's own resolved samples, by identity of its `points` array
 *  (stable for the edge's whole gesture, see edgeFaceSamples). The ghost
 *  redraws on every drag tick, but the model it reads doesn't stay the sharp,
 *  pre-feature one: the FIRST accepted preview already shows the blend
 *  applied, and the edge this ghost is meant to sweep no longer exists as a
 *  sharp corner in it. The two faces and their normals are a property of the
 *  ORIGINAL edge though, not of whatever size is currently previewed, so once
 *  resolved they're locked in and reused rather than re-derived against a
 *  model that has moved on. */
const edgeSampleCache = new WeakMap<readonly Pt3[], EdgeSample[]>();

/** Every EdgeSample along one picked edge, `normal1` pinned to the SAME
 *  physical face (by faceId) across every sample, or null when the edge's
 *  body is gone, it has fewer than 2 points, or too few samples resolve to
 *  find their two faces to draw a continuous ribbon. A single unresolved
 *  sample (a seam, a T-junction) is skipped on its own rather than voiding
 *  the whole edge, as long as enough of the others come through.
 *  Tangent is a central difference of the (evenly resampled) polyline. */
function edgeFaceSamples(model: ModelView, edge: BlendGhostEdge): EdgeSample[] | null {
  const cached = edgeSampleCache.get(edge.points);
  if (cached) return cached;
  const body = model.bodies.find((b) => b.id === edge.body);
  if (!body || edge.points.length < 2) return null;
  const resampled = resampleEdge(edge.points, sampleCount(edge.points.length));
  if (!resampled || resampled.length < 2) return null;

  let primaryFace: number | null = null;
  const out: EdgeSample[] = [];
  for (let i = 0; i < resampled.length; i++) {
    const p = resampled[i]!;
    const found = facesAtPoint(body, p);
    if (!found) continue; // this sample alone, not the whole edge
    let n1: THREE.Vector3, n2: THREE.Vector3;
    if (primaryFace === null || found.faceIds[0] === primaryFace) {
      primaryFace ??= found.faceIds[0];
      n1 = found.normals[0];
      n2 = found.normals[1];
    } else if (found.faceIds[1] === primaryFace) {
      n1 = found.normals[1];
      n2 = found.normals[0];
    } else {
      continue; // neither face matches the pinned one, would twist the ribbon
    }
    const prev = resampled[Math.max(0, i - 1)]!;
    const next = resampled[Math.min(resampled.length - 1, i + 1)]!;
    const tangent = new THREE.Vector3(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
    if (tangent.lengthSq() < 1e-12) continue;
    tangent.normalize();
    out.push({
      point: p,
      tangent: [tangent.x, tangent.y, tangent.z],
      normal1: [n1.x, n1.y, n1.z],
      normal2: [n2.x, n2.y, n2.z],
    });
  }
  if (out.length < MIN_VALID_SAMPLES) return null;
  edgeSampleCache.set(edge.points, out);
  return out;
}

export { resampleEdge, facesAtPoint, edgeFaceSamples };
