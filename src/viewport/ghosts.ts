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

/** A standalone, non-indexed buffer of just `faceIds`' own triangles (their
 *  body's own position buffer, unindexed so faces from different bodies can
 *  share one geometry with no index-space collision), or null when none of
 *  them own a triangle. The features-mode pattern ghost's template. */
function facesGeometry(model: ModelView, faceIds: readonly number[]): THREE.BufferGeometry | null {
  const out: number[] = [];
  for (const faceId of faceIds) {
    const body = bodyOfFace(model, faceId);
    const tris = body?.faceTriangles.get(faceId);
    const index = body?.mesh.geometry.getIndex();
    if (!body || !tris || !index) continue;
    const pos = body.mesh.geometry.getAttribute("position");
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const vi = index.getX(t * 3 + k);
        out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
      }
    }
  }
  if (!out.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  return geo;
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
  // each picked edge for the wedge its two faces make and hands the geometry to
  // features/blendGhost.ts, which sweeps it. An edge whose faces can't be
  // pinned down (a seam, a T-junction, two faces meeting almost flat) is
  // simply left out rather than drawn wrong, see edgeFaceSamples.
  private blendGhostMesh: THREE.Mesh | null = null;

  /** `capped` paints it as a refused size held back to `size`, the largest
   *  one the kernel built. */
  setBlendGhost(edges: readonly BlendGhostEdge[], size: number, kind: BlendKind, capped = false) {
    this.clearBlendGhost();
    const model = this.host.model();
    if (!model || !edges.length || size < 1e-4) return;
    const positions: number[] = [];
    for (const edge of edges) {
      const found = edgeFaceSamples(model, edge);
      if (!found) continue; // can't tell the two faces apart here, skip THIS edge
      const geo = sweepBlendGhost(found.samples, size, kind, found.closed);
      if (geo) positions.push(...geo.positions);
    }
    if (!positions.length) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color: capped ? themeColor("--error", 0xe23b3b) : themeColor("--accent", 0xff7a3c),
      transparent: true,
      opacity: capped ? 0.55 : 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
      // On a convex edge the round sits inside the solid it is about to cut
      // away, where depth testing would hide it completely.
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

  // A features-mode pattern (patternTool.ts, features arg): the copies are of
  // the listed features' own faces, not the whole body they sit on, so a hole
  // patterned in a plate ghosts six holes, not six plates.
  //
  // Unlike setPatternGhost, the template geometry is not shared with the model:
  // it is a fresh, standalone buffer of just those faces' triangles, built once
  // per face set and reused (like the body ghosts) across every copy's matrix.
  private featureGhosts: { key: string; geo: THREE.BufferGeometry; copies: THREE.Mesh[] } | null = null;

  setPatternFeatureGhost(faceIds: readonly number[], matrices: readonly THREE.Matrix4[]) {
    const key = `${faceIds.join(",")}|${matrices.length}`;
    if (!this.featureGhosts || this.featureGhosts.key !== key) {
      this.clearPatternFeatureGhost();
      const model = this.host.model();
      if (!model || !faceIds.length || !matrices.length) return;
      const geo = facesGeometry(model, faceIds);
      if (!geo) return;
      this.patternGhostMat ??= new THREE.MeshBasicMaterial({
        color: themeColor("--accent", 0xff7a3c),
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const copies: THREE.Mesh[] = [];
      // Copy 0 is the original, already on screen, see setPatternGhost.
      for (let i = 1; i < matrices.length; i++) {
        const m = new THREE.Mesh(geo, this.patternGhostMat);
        m.matrixAutoUpdate = false;
        m.renderOrder = 1;
        copies.push(m);
        this.host.addToScene(m);
      }
      this.featureGhosts = { key, geo, copies };
    }
    for (let i = 0; i < this.featureGhosts.copies.length; i++) {
      const m = this.featureGhosts.copies[i];
      const mat = matrices[i + 1];
      if (m && mat) {
        m.matrix.copy(mat);
        m.updateMatrixWorld(true);
      }
    }
    this.host.requestRender();
  }

  clearPatternFeatureGhost() {
    if (this.featureGhosts) {
      for (const m of this.featureGhosts.copies) this.host.removeFromScene(m);
      this.featureGhosts.geo.dispose();
      this.featureGhosts = null;
    }
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
// where three faces meet. So an open edge is resampled at points strictly
// BETWEEN its ends to find its faces, and its end sections are carried out to
// the true endpoints afterwards; a closed loop has no corner and is sampled
// all the way round.

interface TriRec {
  faceId: number;
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  normal: THREE.Vector3;
  /** the shipped per-vertex surface normals, when the mesh has them */
  vn: [THREE.Vector3, THREE.Vector3, THREE.Vector3] | null;
  centroid: THREE.Vector3;
}

/** A uniform hash grid of a body's triangles, bucketed by centroid, cell size
 *  set from the mesh's own average edge length. `tolerance` is how far a
 *  sample point may sit from the nearest triangle and still count as on it. */
interface TriGrid {
  cellSize: number;
  tolerance: number;
  cells: Map<string, TriRec[]>;
  byFace: Map<number, TriRec[]>;
}

const triGridCache = new WeakMap<BodyMesh, TriGrid>();

function cellKey(x: number, y: number, z: number, cellSize: number): string {
  return `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;
}

function buildTriGrid(body: BodyMesh): TriGrid {
  const pos = body.mesh.geometry.getAttribute("position");
  const nrm = body.mesh.geometry.getAttribute("normal");
  const index = body.mesh.geometry.getIndex();
  const triCount = index ? index.count / 3 : 0;
  const recs: TriRec[] = [];
  let edgeLenSum = 0, edgeLenCount = 0;
  if (pos && index) {
    for (let t = 0; t < triCount; t++) {
      const fid = body.faceIds[t];
      if (fid === undefined) continue;
      const ia = index.getX(t * 3), ib = index.getX(t * 3 + 1), ic = index.getX(t * 3 + 2);
      const a = new THREE.Vector3().fromBufferAttribute(pos, ia);
      const b = new THREE.Vector3().fromBufferAttribute(pos, ib);
      const c = new THREE.Vector3().fromBufferAttribute(pos, ic);
      const normal = b.clone().sub(a).cross(c.clone().sub(a));
      const len = normal.length();
      if (len < 1e-12) continue;
      normal.divideScalar(len);
      const vn: TriRec["vn"] = nrm
        ? [
            new THREE.Vector3().fromBufferAttribute(nrm, ia),
            new THREE.Vector3().fromBufferAttribute(nrm, ib),
            new THREE.Vector3().fromBufferAttribute(nrm, ic),
          ]
        : null;
      const centroid = a.clone().add(b).add(c).divideScalar(3);
      recs.push({ faceId: fid, a, b, c, normal, vn, centroid });
      edgeLenSum += a.distanceTo(b) + b.distanceTo(c) + c.distanceTo(a);
      edgeLenCount += 3;
    }
  }
  const avgEdge = edgeLenCount ? edgeLenSum / edgeLenCount : 1;
  const cellSize = Math.max(avgEdge, 1e-3);
  const tolerance = Math.max(avgEdge * 3, 0.05);
  const cells = new Map<string, TriRec[]>();
  const byFace = new Map<number, TriRec[]>();
  for (const r of recs) {
    const key = cellKey(r.centroid.x, r.centroid.y, r.centroid.z, cellSize);
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(r);
    let own = byFace.get(r.faceId);
    if (!own) byFace.set(r.faceId, (own = []));
    own.push(r);
  }
  return { cellSize, tolerance, cells, byFace };
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
/** A shipped vertex normal is only trusted this close to the facet's own: a
 *  body without true normals has them averaged across the very edge sampled. */
const VERTEX_NORMAL_AGREEMENT = Math.cos(Math.PI / 6);

/** The face's surface normal at `at` on `tri`, up to sign: the shipped vertex
 *  normals interpolated there when they agree with the facet, else the facet's.
 *  The facet alone is off by half a facet's turn on a curved face. */
function surfaceNormal(tri: TriRec, at: THREE.Vector3): THREE.Vector3 {
  if (tri.vn) {
    const n = THREE.Triangle.getInterpolation(at, tri.a, tri.b, tri.c, tri.vn[0], tri.vn[1], tri.vn[2], new THREE.Vector3());
    if (n && n.lengthSq() > 1e-12) {
      n.normalize();
      if (Math.abs(n.dot(tri.normal)) >= VERTEX_NORMAL_AGREEMENT) return n;
    }
  }
  return tri.normal.clone();
}

interface FaceHit {
  faceId: number;
  dist: number;
  tri: TriRec;
  closest: THREE.Vector3;
}

/** The two faces nearest one point on an edge, each with its surface normal
 *  there and the triangle it came from, or null when fewer than two distinct
 *  faces have a triangle within tolerance. */
function facesAtPoint(
  body: BodyMesh,
  p: Pt3,
): { faceIds: [number, number]; normals: [THREE.Vector3, THREE.Vector3]; tris: [TriRec, TriRec] } | null {
  const grid = triGrid(body);
  if (!grid.cells.size) return null;
  const pv = new THREE.Vector3(p[0], p[1], p[2]);
  const cs = grid.cellSize;
  const cx = Math.floor(pv.x / cs), cy = Math.floor(pv.y / cs), cz = Math.floor(pv.z / cs);
  const reach = Math.max(1, Math.ceil(grid.tolerance / cs)) + 1;
  const byFace = new Map<number, FaceHit>();
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
          if (!prev || dist < prev.dist) byFace.set(t.faceId, { faceId: t.faceId, dist, tri: t, closest: scratchClosest.clone() });
        }
      }
    }
  }
  if (byFace.size < 2) return null;
  const [h0, h1] = [...byFace.values()].sort((a, b) => a.dist - b.dist) as [FaceHit, FaceHit];
  return {
    faceIds: [h0.faceId, h1.faceId],
    normals: [surfaceNormal(h0.tri, h0.closest), surfaceNormal(h1.tri, h1.closest)],
    tris: [h0.tri, h1.tri],
  };
}

/** The direction that leaves the edge at `p` across the face `tri` belongs to:
 *  in the face's tangent plane, perpendicular to the edge, signed by the
 *  triangle vertex that stands furthest off the edge. */
function intoFace(tri: TriRec, normal: THREE.Vector3, p: THREE.Vector3, tangent: THREE.Vector3): THREE.Vector3 | null {
  const d = tangent.clone().cross(normal);
  if (d.lengthSq() < 1e-12) return null;
  d.normalize();
  let best = 0;
  for (const v of [tri.a, tri.b, tri.c]) {
    const s = v.clone().sub(p).dot(d);
    if (Math.abs(s) > Math.abs(best)) best = s;
  }
  if (Math.abs(best) < 1e-9) return null;
  return best < 0 ? d.negate() : d;
}

/** How far the face runs from the edge at `p` before it ends, measured along
 *  `into` in the plane across the edge: the furthest point where that plane
 *  cuts the face's own triangles, ahead of the edge and not swung further
 *  sideways than it is ahead (which a far wall of the same face would be).
 *  Infinity when the plane finds nothing to measure. */
function faceReach(tris: readonly TriRec[], p: THREE.Vector3, tangent: THREE.Vector3, into: THREE.Vector3, tol: number): number {
  const lateral = tangent.clone().cross(into);
  let reach = -Infinity;
  const s = [0, 0, 0], l = [0, 0, 0], d = [0, 0, 0];
  for (const t of tris) {
    const vs = [t.a, t.b, t.c];
    for (let i = 0; i < 3; i++) {
      const v = vs[i]!;
      const x = v.x - p.x, y = v.y - p.y, z = v.z - p.z;
      d[i] = x * tangent.x + y * tangent.y + z * tangent.z;
      s[i] = x * into.x + y * into.y + z * into.z;
      l[i] = x * lateral.x + y * lateral.y + z * lateral.z;
    }
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const di = d[i]!, dj = d[j]!;
      let ss: number, ll: number;
      if (Math.abs(di) < 1e-9) {
        ss = s[i]!;
        ll = l[i]!;
      } else if (di * dj < 0) {
        const f = di / (di - dj);
        ss = s[i]! + (s[j]! - s[i]!) * f;
        ll = l[i]! + (l[j]! - l[i]!) * f;
      } else continue;
      if (ss > reach && Math.abs(ll) <= ss + tol) reach = ss;
    }
  }
  return reach > 0 ? reach : Infinity;
}

/** How much the face `tri` belongs to curls toward `side` as it leaves the
 *  edge along `into`, in 1/mm, read off the turn of the shipped normals from
 *  `p` to the triangle's far vertex. 0 when the mesh has no normals to trust. */
function faceBend(
  tri: TriRec,
  normalAtP: THREE.Vector3,
  p: THREE.Vector3,
  tangent: THREE.Vector3,
  into: THREE.Vector3,
  side: THREE.Vector3,
): number {
  if (!tri.vn) return 0;
  let far = -1, a = 0;
  [tri.a, tri.b, tri.c].forEach((v, i) => {
    const s = v.clone().sub(p).dot(into);
    if (s > a) { a = s; far = i; }
  });
  if (far < 0 || a < 1e-6) return 0;
  const nv = tri.vn[far]!.clone();
  if (Math.abs(nv.dot(tri.normal)) < VERTEX_NORMAL_AGREEMENT * nv.length()) return 0;
  const m = normalAtP.clone().addScaledVector(tangent, -normalAtP.dot(tangent));
  nv.addScaledVector(tangent, -nv.dot(tangent));
  if (m.lengthSq() < 1e-12 || nv.lengthSq() < 1e-12) return 0;
  m.normalize();
  if (nv.dot(m) < 0) nv.negate();
  const turn = -Math.atan2(nv.dot(into), nv.dot(m));
  return (Math.sin(turn) / a) * Math.sign(m.dot(side));
}

/** True when a polyline's two ends meet: a circle, a slot's whole outline. */
function isClosedPolyline(pts: readonly Pt3[]): boolean {
  if (pts.length < 3) return false;
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const a = pts[0]!, b = pts[pts.length - 1]!;
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) <= Math.max(total * 1e-4, 1e-6);
}

/** `count` points along an edge polyline, evenly spaced by arc length. An open
 *  one is inset from both ends so a straight edge's two corner points (where
 *  a third face joins in) are never sampled; a closed one is walked all the way
 *  round from its first point, without repeating it at the end. Null on a
 *  degenerate (zero-length) polyline. */
function resampleEdge(pts: readonly Pt3[], count: number, closed = false): Pt3[] | null {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0, z0] = pts[i - 1]!, [x1, y1, z1] = pts[i]!;
    cum.push(cum[i - 1]! + Math.hypot(x1 - x0, y1 - y0, z1 - z0));
  }
  const total = cum[cum.length - 1]!;
  if (total < 1e-9) return null;
  const inset = closed ? 0 : total * 0.04;
  const span = total - inset * 2;
  if (span <= 0) return null;
  const out: Pt3[] = [];
  let seg = 0;
  for (let i = 0; i < count; i++) {
    const f = closed ? i / count : count === 1 ? 0.5 : i / (count - 1);
    const target = inset + f * span;
    while (seg < cum.length - 2 && cum[seg + 1]! < target) seg++;
    const segLen = cum[seg + 1]! - cum[seg]!;
    const t = segLen > 1e-12 ? (target - cum[seg]!) / segLen : 0;
    const a = pts[seg]!, b = pts[seg + 1]!;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  return out;
}

/** Between 12 and 64 resample points: more for an edge whose own polyline
 *  already carries more detail (a curved edge), never fewer than 12. */
function sampleCount(polylineLen: number): number {
  return Math.min(64, Math.max(12, polylineLen));
}

/** An edge is still drawable with some samples missing; below this many the
 *  ribbon would be too sparse to read as a fillet, so the whole edge is
 *  dropped instead. */
const MIN_VALID_SAMPLES = 4;

export interface EdgeGhostSamples {
  samples: EdgeSample[];
  closed: boolean;
}

/** A picked edge's resolved samples, by identity of its `points` array. The
 *  first accepted preview already shows the blend applied, and the sharp
 *  corner this ghost sweeps no longer exists in that model, so the faces are
 *  resolved once, against the model the gesture started on, and reused. */
const edgeSampleCache = new WeakMap<readonly Pt3[], EdgeGhostSamples>();

/** `from` turned by the rotation that takes tangent `t0` to `t1`, what carries
 *  an inset sample's wedge out to the edge's true end. */
function turned(from: Pt3, t0: THREE.Vector3, t1: THREE.Vector3): Pt3 {
  const q = new THREE.Quaternion().setFromUnitVectors(t0, t1);
  const v = new THREE.Vector3(from[0], from[1], from[2]).applyQuaternion(q);
  return [v.x, v.y, v.z];
}

function unitTangent(a: Pt3, b: Pt3): THREE.Vector3 | null {
  const t = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  return t.lengthSq() < 1e-12 ? null : t.normalize();
}

function endSample(point: Pt3, t1: THREE.Vector3 | null, s: EdgeSample): EdgeSample | null {
  if (!t1) return null;
  const t0 = new THREE.Vector3(s.tangent[0], s.tangent[1], s.tangent[2]);
  return { ...s, point, tangent: [t1.x, t1.y, t1.z], into1: turned(s.into1, t0, t1), into2: turned(s.into2, t0, t1) };
}

/** Every EdgeSample along one picked edge, face 1 pinned to the SAME physical
 *  face (by faceId) throughout, or null when the edge's body is gone, it has
 *  fewer than 2 points, or too few samples find their two faces. A single
 *  unresolved sample (a seam, a T-junction) is skipped on its own. */
function edgeFaceSamples(model: ModelView, edge: BlendGhostEdge): EdgeGhostSamples | null {
  const cached = edgeSampleCache.get(edge.points);
  if (cached) return cached;
  const body = model.bodies.find((b) => b.id === edge.body);
  if (!body || edge.points.length < 2) return null;
  const closed = isClosedPolyline(edge.points);
  const resampled = resampleEdge(edge.points, sampleCount(edge.points.length), closed);
  if (!resampled || resampled.length < 2) return null;

  const grid = triGrid(body);
  const n = resampled.length;
  let primaryFace: number | null = null;
  const samples: EdgeSample[] = [];
  for (let i = 0; i < n; i++) {
    const p = resampled[i]!;
    const found = facesAtPoint(body, p);
    if (!found) continue;
    let k1: 0 | 1;
    if (primaryFace === null || found.faceIds[0] === primaryFace) {
      primaryFace ??= found.faceIds[0];
      k1 = 0;
    } else if (found.faceIds[1] === primaryFace) {
      k1 = 1;
    } else {
      continue;
    }
    const k2 = k1 === 0 ? 1 : 0;
    const prev = resampled[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!;
    const next = resampled[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!;
    const tangent = unitTangent(prev, next);
    if (!tangent) continue;
    const pv = new THREE.Vector3(p[0], p[1], p[2]);
    const d1 = intoFace(found.tris[k1], found.normals[k1], pv, tangent);
    const d2 = intoFace(found.tris[k2], found.normals[k2], pv, tangent);
    if (!d1 || !d2) continue;
    const side1 = d2.clone().addScaledVector(d1, -d2.dot(d1));
    const side2 = d1.clone().addScaledVector(d2, -d1.dot(d2));
    if (side1.lengthSq() < 1e-12 || side2.lengthSq() < 1e-12) continue;
    samples.push({
      point: p,
      tangent: [tangent.x, tangent.y, tangent.z],
      into1: [d1.x, d1.y, d1.z],
      into2: [d2.x, d2.y, d2.z],
      bend1: faceBend(found.tris[k1], found.normals[k1], pv, tangent, d1, side1.normalize()),
      bend2: faceBend(found.tris[k2], found.normals[k2], pv, tangent, d2, side2.normalize()),
      reach1: faceReach(grid.byFace.get(found.faceIds[k1]) ?? [], pv, tangent, d1, grid.tolerance),
      reach2: faceReach(grid.byFace.get(found.faceIds[k2]) ?? [], pv, tangent, d2, grid.tolerance),
    });
  }
  if (samples.length < MIN_VALID_SAMPLES) return null;

  if (!closed) {
    const pts = edge.points;
    const head = endSample(pts[0]!, unitTangent(pts[0]!, pts[1]!), samples[0]!);
    const tail = endSample(pts[pts.length - 1]!, unitTangent(pts[pts.length - 2]!, pts[pts.length - 1]!), samples[samples.length - 1]!);
    if (head) samples.unshift(head);
    if (tail) samples.push(tail);
  }
  const out = { samples, closed };
  edgeSampleCache.set(edge.points, out);
  return out;
}

export { resampleEdge, facesAtPoint, edgeFaceSamples };
