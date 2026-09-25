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
import { TRIM_BUDGET, sectionOutline, sweepBlendGhost, type BlendKind, type EdgeSample, type Pt3 } from "../features/blendGhost";
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
    let unsure = false;
    // One budget for the whole update, however many edges are picked.
    const budget = { left: TRIM_BUDGET, failed: false };
    for (const edge of edges) {
      const found = edgeFaceSamples(model, edge);
      if (!found) continue; // can't tell the two faces apart here, skip THIS edge
      const geo = sweepBlendGhost(found.samples, size, kind, found.closed, budget);
      if (!geo) continue;
      positions.push(...geo.positions);
      unsure ||= geo.unsure;
    }
    if (!positions.length) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color: capped ? themeColor("--error", 0xe23b3b) : themeColor("--accent", 0xff7a3c),
      transparent: true,
      opacity: capped ? 0.55 : unsure ? 0.2 : 0.45,
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
}

/** A body's triangles in flat arrays, and a uniform hash grid of them bucketed
 *  by centroid, cell size set from the mesh's own average edge length.
 *  `tolerance` is how far a sample point may sit from the nearest triangle and
 *  still count as on it. */
interface TriGrid {
  count: number;
  /** each triangle's three corners, 9 numbers */
  corners: Float64Array;
  faceOf: Int32Array;
  /** each triangle's three vertex indices, to read its shipped normals */
  verts: Uint32Array;
  normals: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null;
  cellSize: number;
  tolerance: number;
  origin: [number, number, number];
  dims: [number, number, number];
  cells: Map<number, number[]>;
  /** each face's triangles, filled in as faces are asked for */
  byFace: Map<number, Int32Array>;
}

const triGridCache = new WeakMap<BodyMesh, TriGrid>();

/** The attribute's own array when it can be read directly, as plain
 *  `itemSize` tuples. */
function plainArray(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined, itemSize: number): ArrayLike<number> | null {
  if (!a || (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return null;
  return a.itemSize === itemSize && !a.normalized && a.array ? a.array : null;
}

function buildTriGrid(body: BodyMesh): TriGrid {
  const geo = body.mesh.geometry;
  const pos = geo.getAttribute("position");
  const index = geo.getIndex();
  const triCount = pos && index ? index.count / 3 : 0;
  const P = plainArray(pos, 3), I = plainArray(index, 1);
  const corners = new Float64Array(triCount * 9);
  const faceOf = new Int32Array(triCount);
  const verts = new Uint32Array(triCount * 3);
  let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
  if (I) for (let i = 0; i < triCount * 3; i++) verts[i] = I[i]!;
  else for (let i = 0; i < triCount * 3; i++) verts[i] = index!.getX(i);
  for (let i = 0; i < triCount * 3; i++) {
    const v = verts[i]!;
    corners[i * 3] = P ? P[v * 3]! : pos!.getX(v);
    corners[i * 3 + 1] = P ? P[v * 3 + 1]! : pos!.getY(v);
    corners[i * 3 + 2] = P ? P[v * 3 + 2]! : pos!.getZ(v);
  }
  let n = 0, edgeLenSum = 0;
  for (let t = 0; t < triCount; t++) {
    const fid = body.faceIds[t];
    if (fid === undefined) continue;
    const s = t * 9, o = n * 9;
    const ax = corners[s]!, ay = corners[s + 1]!, az = corners[s + 2]!;
    const abx = corners[s + 3]! - ax, aby = corners[s + 4]! - ay, abz = corners[s + 5]! - az;
    const acx = corners[s + 6]! - ax, acy = corners[s + 7]! - ay, acz = corners[s + 8]! - az;
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    if (nx * nx + ny * ny + nz * nz < 1e-24) continue;
    if (o !== s) {
      corners.copyWithin(o, s, s + 9);
      verts.copyWithin(n * 3, t * 3, t * 3 + 3);
    }
    const bcx = acx - abx, bcy = acy - aby, bcz = acz - abz;
    edgeLenSum += Math.sqrt(abx * abx + aby * aby + abz * abz) + Math.sqrt(acx * acx + acy * acy + acz * acz)
      + Math.sqrt(bcx * bcx + bcy * bcy + bcz * bcz);
    const cx = ax + (abx + acx) / 3, cy = ay + (aby + acy) / 3, cz = az + (abz + acz) / 3;
    if (cx < lx) lx = cx;
    if (cx > hx) hx = cx;
    if (cy < ly) ly = cy;
    if (cy > hy) hy = cy;
    if (cz < lz) lz = cz;
    if (cz > hz) hz = cz;
    faceOf[n] = fid;
    n++;
  }
  const avgEdge = n ? edgeLenSum / (n * 3) : 1;
  const cellSize = Math.max(avgEdge, 1e-3);
  const tolerance = Math.max(avgEdge * 3, 0.05);
  const origin: [number, number, number] = n ? [lx, ly, lz] : [0, 0, 0];
  const dims: [number, number, number] = n
    ? [Math.floor((hx - lx) / cellSize) + 1, Math.floor((hy - ly) / cellSize) + 1, Math.floor((hz - lz) / cellSize) + 1]
    : [0, 0, 0];
  const cells = new Map<number, number[]>();
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ix = Math.min(dims[0] - 1, Math.floor(((corners[o]! + corners[o + 3]! + corners[o + 6]!) / 3 - lx) / cellSize));
    const iy = Math.min(dims[1] - 1, Math.floor(((corners[o + 1]! + corners[o + 4]! + corners[o + 7]!) / 3 - ly) / cellSize));
    const iz = Math.min(dims[2] - 1, Math.floor(((corners[o + 2]! + corners[o + 5]! + corners[o + 8]!) / 3 - lz) / cellSize));
    const key = ix + dims[0] * (iy + dims[1] * iz);
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(t);
  }
  return {
    count: n,
    corners: corners.subarray(0, n * 9),
    faceOf: faceOf.subarray(0, n),
    verts: verts.subarray(0, n * 3),
    normals: geo.getAttribute("normal") ?? null,
    cellSize, tolerance, origin, dims, cells, byFace: new Map(),
  };
}

function faceTris(g: TriGrid, faceId: number): Int32Array {
  let own = g.byFace.get(faceId);
  if (!own) {
    let k = 0;
    for (let t = 0; t < g.count; t++) if (g.faceOf[t] === faceId) k++;
    own = new Int32Array(k);
    for (let t = 0, i = 0; t < g.count; t++) if (g.faceOf[t] === faceId) own[i++] = t;
    g.byFace.set(faceId, own);
  }
  return own;
}

function triGrid(body: BodyMesh): TriGrid {
  let g = triGridCache.get(body);
  if (!g) {
    g = buildTriGrid(body);
    triGridCache.set(body, g);
  }
  return g;
}

function triRec(g: TriGrid, t: number): TriRec {
  const c = g.corners, o = t * 9;
  const a = new THREE.Vector3(c[o], c[o + 1], c[o + 2]);
  const b = new THREE.Vector3(c[o + 3], c[o + 4], c[o + 5]);
  const cc = new THREE.Vector3(c[o + 6], c[o + 7], c[o + 8]);
  const normal = b.clone().sub(a).cross(cc.clone().sub(a)).normalize();
  const nrm = g.normals;
  const vn = nrm
    ? ([0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(nrm, g.verts[t * 3 + k]!)) as TriRec["vn"])
    : null;
  return { faceId: g.faceOf[t]!, a, b, c: cc, normal, vn };
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
  tri: number;
  closest: THREE.Vector3;
}

/** Squared distance from `p` to the box around triangle `t`, a floor under
 *  its distance to the triangle itself. */
function boxDistanceSq(c: Float64Array, t: number, p: Pt3): number {
  const o = t * 9;
  let dd = 0;
  for (let k = 0; k < 3; k++) {
    const a = c[o + k]!, b = c[o + 3 + k]!, e = c[o + 6 + k]!;
    const q = p[k as 0 | 1 | 2];
    const g = q < a && q < b && q < e ? Math.min(a, b, e) - q : q > a && q > b && q > e ? q - Math.max(a, b, e) : 0;
    dd += g * g;
  }
  return dd;
}

interface FacesAt {
  faceIds: [number, number];
  normals: [THREE.Vector3, THREE.Vector3];
  tris: [TriRec, TriRec];
  /** how far the point is from the second face */
  second: number;
}

/** The grid cells within tolerance of `p`, as their triangle lists. */
function cellsNear(grid: TriGrid, p: Pt3): number[][] {
  const cs = grid.cellSize, [nx, ny, nz] = grid.dims;
  const at = (k: 0 | 1 | 2) => Math.floor((p[k] - grid.origin[k]) / cs);
  const reach = Math.max(1, Math.ceil(grid.tolerance / cs)) + 1;
  const [cx, cy, cz] = [at(0), at(1), at(2)];
  const out: number[][] = [];
  for (let ix = Math.max(0, cx - reach); ix <= Math.min(nx - 1, cx + reach); ix++) {
    for (let iy = Math.max(0, cy - reach); iy <= Math.min(ny - 1, cy + reach); iy++) {
      for (let iz = Math.max(0, cz - reach); iz <= Math.min(nz - 1, cz + reach); iz++) {
        const list = grid.cells.get(ix + nx * (iy + ny * iz));
        if (list) out.push(list);
      }
    }
  }
  return out;
}

/** The two faces nearest one point on an edge, each with its surface normal
 *  there and the triangle it came from, or null when fewer than two distinct
 *  faces have a triangle within tolerance. Searched among `among` when given,
 *  else the grid cells around the point, and only `within` of it. */
function facesAtPoint(body: BodyMesh, p: Pt3, among?: readonly (readonly number[] | Int32Array)[], within = Infinity): FacesAt | null {
  const grid = triGrid(body);
  if (!grid.cells.size) return null;
  const pv = new THREE.Vector3(p[0], p[1], p[2]);
  const c = grid.corners;
  const byFace = new Map<number, FaceHit>();
  // A triangle further off than the second nearest face so far can change
  // neither which two faces are nearest nor where they are nearest.
  let bound = Math.min(grid.tolerance, within);
  for (const list of among ?? cellsNear(grid, p)) {
    for (const t of list) {
      if (boxDistanceSq(c, t, p) > bound * bound) continue;
      const o = t * 9;
      scratchTri.a.set(c[o]!, c[o + 1]!, c[o + 2]!);
      scratchTri.b.set(c[o + 3]!, c[o + 4]!, c[o + 5]!);
      scratchTri.c.set(c[o + 6]!, c[o + 7]!, c[o + 8]!);
      scratchTri.closestPointToPoint(pv, scratchClosest);
      const dist = scratchClosest.distanceTo(pv);
      if (dist > grid.tolerance) continue;
      const faceId = grid.faceOf[t]!;
      const prev = byFace.get(faceId);
      if (prev && dist >= prev.dist) continue;
      byFace.set(faceId, { faceId, dist, tri: t, closest: scratchClosest.clone() });
      if (byFace.size >= 2) {
        let first = Infinity, second = Infinity;
        for (const h of byFace.values()) {
          if (h.dist < first) [first, second] = [h.dist, first];
          else if (h.dist < second) second = h.dist;
        }
        bound = Math.min(grid.tolerance, within, second);
      }
    }
  }
  if (byFace.size < 2) return null;
  const [h0, h1] = [...byFace.values()].sort((a, b) => a.dist - b.dist) as [FaceHit, FaceHit];
  const tris: [TriRec, TriRec] = [triRec(grid, h0.tri), triRec(grid, h1.tri)];
  return {
    faceIds: [h0.faceId, h1.faceId],
    normals: [surfaceNormal(tris[0], h0.closest), surfaceNormal(tris[1], h1.closest)],
    tris,
    second: h1.dist,
  };
}

/** The triangles whose boxes come within `within` of the box around `pts`,
 *  every one that can be that close to a point on the polyline. */
function trianglesNear(grid: TriGrid, pts: readonly Pt3[], within: number): Int32Array {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const q of pts) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, q[k as 0 | 1 | 2] - within);
      hi[k] = Math.max(hi[k]!, q[k as 0 | 1 | 2] + within);
    }
  }
  const c = grid.corners;
  const out: number[] = [];
  outer: for (let t = 0; t < grid.count; t++) {
    const o = t * 9;
    for (let k = 0; k < 3; k++) {
      const a = c[o + k]!, b = c[o + 3 + k]!, e = c[o + 6 + k]!;
      if ((a < lo[k]! && b < lo[k]! && e < lo[k]!) || (a > hi[k]! && b > hi[k]! && e > hi[k]!)) continue outer;
    }
    out.push(t);
  }
  return Int32Array.from(out);
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
 *  Looked for among `tris`, which must hold every triangle of the face the
 *  plane cuts. Infinity when the plane finds nothing to measure. */
function faceReach(
  g: TriGrid,
  face: number,
  tris: ArrayLike<number>,
  p: THREE.Vector3,
  tangent: THREE.Vector3,
  into: THREE.Vector3,
  tol: number,
): number {
  const lateral = tangent.clone().cross(into);
  const c = g.corners;
  let reach = -Infinity;
  const s = [0, 0, 0], l = [0, 0, 0], d = [0, 0, 0];
  for (let k = 0; k < tris.length; k++) {
    const t = tris[k]!;
    if (g.faceOf[t] !== face) continue;
    const o = t * 9;
    let ahead = 0, behind = 0;
    for (let i = 0; i < 3; i++) {
      const di = (c[o + i * 3]! - p.x) * tangent.x + (c[o + i * 3 + 1]! - p.y) * tangent.y + (c[o + i * 3 + 2]! - p.z) * tangent.z;
      d[i] = di;
      if (di > 1e-9) ahead++;
      else if (di < -1e-9) behind++;
    }
    if (ahead === 3 || behind === 3) continue;
    let far = -Infinity;
    for (let i = 0; i < 3; i++) {
      const si = (c[o + i * 3]! - p.x) * into.x + (c[o + i * 3 + 1]! - p.y) * into.y + (c[o + i * 3 + 2]! - p.z) * into.z;
      s[i] = si;
      if (si > far) far = si;
    }
    if (far <= reach) continue;
    for (let i = 0; i < 3; i++) {
      l[i] = (c[o + i * 3]! - p.x) * lateral.x + (c[o + i * 3 + 1]! - p.y) * lateral.y + (c[o + i * 3 + 2]! - p.z) * lateral.z;
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

/** mm around an edge within which a sample's two faces are looked for
 *  first, before the whole tolerance. */
const NEAR_EDGE = 1;

/** Triangle tests one edge may spend sectioning the body, and triangles its
 *  planes may cut in all, past which the outline is left out and the ghost
 *  falls back to capping at the face ends. A straight edge's parallel planes
 *  are sorted out in one pass, so there only the cuts count. */
const OUTLINE_TESTS = 2e6;
const OUTLINE_CUTS = 4e5;
/** Outline segments kept across one edge's samples, nearest the edge first. */
const OUTLINE_KEEP = 1e5;
/** Triangle tests one edge may spend measuring how far its faces run; a face
 *  bigger than that is measured at every few samples only. */
const REACH_BUDGET = 5e5;

let outlineScratch = new Float64Array(4096);

const dotAt = (c: Float64Array, i: number, v: THREE.Vector3) => c[i]! * v.x + c[i + 1]! * v.y + c[i + 2]! * v.z;

/** The triangles each of the parallel planes across `tangent` through
 *  `points` cuts, or null when that is more than `budget` cuts in all. */
function cutsAlongLine(g: TriGrid, tangent: THREE.Vector3, points: readonly THREE.Vector3[], budget: number): number[][] | null {
  const order = points.map((p, i) => [p.dot(tangent), i] as const).sort((a, b) => a[0] - b[0]);
  const keys = order.map(([k]) => k);
  const m = keys.length, c = g.corners;
  // The first sorted key above `k`, from a guess that is exact for evenly
  // spaced samples.
  const k0 = keys[0]!, step = m > 1 ? (keys[m - 1]! - k0) / (m - 1) : 0;
  const above = (k: number) => {
    let i = step > 0 ? Math.max(0, Math.min(m, Math.ceil((k - k0) / step))) : 0;
    while (i > 0 && keys[i - 1]! > k) i--;
    while (i < m && keys[i]! <= k) i++;
    return i;
  };
  const span = new Int32Array(g.count * 2);
  let total = 0;
  for (let t = 0; t < g.count; t++) {
    const k0 = dotAt(c, t * 9, tangent), k1 = dotAt(c, t * 9 + 3, tangent), k2 = dotAt(c, t * 9 + 6, tangent);
    const first = above(Math.min(k0, k1, k2)), last = above(Math.max(k0, k1, k2)) - 1;
    span[t * 2] = first;
    span[t * 2 + 1] = last;
    if (last >= first) total += last - first + 1;
    if (total > budget) return null;
  }
  const lists: number[][] = points.map(() => []);
  for (let t = 0; t < g.count; t++) {
    for (let s = span[t * 2]!; s <= span[t * 2 + 1]!; s++) lists[order[s]![1]]!.push(t);
  }
  return lists;
}

/** The body cut by the plane through `p` across `tangent`, as 2D segments
 *  x0,y0,x1,y1 in the frame (x, y) with `p` at the origin, from the triangles
 *  `among` or else all of them. Each crossing is worked out from the vertex
 *  on or ahead of the plane, so the two triangles sharing an edge put their
 *  segments' common end at exactly the same point. The result is a view of a
 *  buffer the next call reuses. */
function bodyOutline(
  body: BodyMesh,
  p: THREE.Vector3,
  tangent: THREE.Vector3,
  x: THREE.Vector3,
  y: THREE.Vector3,
  among?: readonly number[],
): Float64Array {
  const g = triGrid(body);
  const c = g.corners;
  const pT = p.dot(tangent), px = p.dot(x), py = p.dot(y);
  let out = outlineScratch, n = 0;
  const d = [0, 0, 0], u = [0, 0, 0], w = [0, 0, 0];
  const count = among ? among.length : g.count;
  for (let i = 0; i < count; i++) {
    const o = (among ? among[i]! : i) * 9;
    const d0 = dotAt(c, o, tangent) - pT, d1 = dotAt(c, o + 3, tangent) - pT, d2 = dotAt(c, o + 6, tangent) - pT;
    if (d0 >= 0 ? d1 >= 0 && d2 >= 0 : d1 < 0 && d2 < 0) continue;
    d[0] = d0;
    d[1] = d1;
    d[2] = d2;
    for (let k = 0; k < 3; k++) {
      u[k] = dotAt(c, o + k * 3, x) - px;
      w[k] = dotAt(c, o + k * 3, y) - py;
    }
    if (n + 4 > out.length) {
      const grown = new Float64Array(out.length * 2);
      grown.set(out);
      out = outlineScratch = grown;
    }
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3;
      if (d[a]! >= 0 === d[b]! >= 0) continue;
      const h = d[a]! >= 0 ? a : b, l = h === a ? b : a;
      const f = d[h]! / (d[h]! - d[l]!);
      out[n++] = u[h]! + (u[l]! - u[h]!) * f;
      out[n++] = w[h]! + (w[l]! - w[h]!) * f;
    }
  }
  return out.subarray(0, n);
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
  // The edge's own neighbourhood, searched instead of the grid wherever that
  // is less work: on a mesh of long slivers every grid cell holds most of it.
  const within = Math.min(grid.tolerance, NEAR_EDGE);
  const near = [trianglesNear(grid, edge.points, within)];
  let primaryFace: number | null = null;
  const wedges: {
    p: Pt3; pv: THREE.Vector3; tangent: THREE.Vector3; d1: THREE.Vector3; d2: THREE.Vector3; side1: THREE.Vector3;
    faces: [number, number]; bend1: number; bend2: number;
  }[] = [];
  for (let i = 0; i < n; i++) {
    const p = resampled[i]!;
    const cells = cellsNear(grid, p);
    let found: FacesAt | null = null;
    if (near[0]!.length < cells.reduce((sum, l) => sum + l.length, 0)) {
      found = facesAtPoint(body, p, near, within / 16) ?? facesAtPoint(body, p, near, within);
    }
    found ??= facesAtPoint(body, p, cells);
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
    side1.normalize();
    wedges.push({
      p, pv, tangent, d1, d2, side1,
      faces: [found.faceIds[k1], found.faceIds[k2]],
      bend1: faceBend(found.tris[k1], found.normals[k1], pv, tangent, d1, side1),
      bend2: faceBend(found.tris[k2], found.normals[k2], pv, tangent, d2, side2.normalize()),
    });
  }
  if (wedges.length < MIN_VALID_SAMPLES) return null;

  const m = wedges.length;
  const straight = !closed && wedges.every((w) => w.tangent.dot(wedges[0]!.tangent) > 1 - 1e-12);
  const lineCuts = straight ? cutsAlongLine(grid, wedges[0]!.tangent, wedges.map((w) => w.pv), OUTLINE_CUTS) : null;
  const reaches = ([0, 1] as const).map((slot) => {
    const face = (j: number) => wedges[j]!.faces[slot];
    const size = (j: number) => faceTris(grid, face(j)).length;
    const out = new Array<number>(m).fill(NaN);
    for (let j = 0; j < m; j++) {
      const w = wedges[j]!;
      if (lineCuts) {
        out[j] = faceReach(grid, face(j), lineCuts[j]!, w.pv, wedges[0]!.tangent, slot ? w.d2 : w.d1, grid.tolerance);
        continue;
      }
      const stride = Math.ceil((m * size(j)) / REACH_BUDGET);
      if (stride > 1 && j % stride && j < m - 1 && face(j - 1) === face(j) && face(j + 1) === face(j)) continue;
      out[j] = faceReach(grid, face(j), faceTris(grid, face(j)), w.pv, w.tangent, slot ? w.d2 : w.d1, grid.tolerance);
    }
    // In between, the nearer end of the face measured on either side.
    for (let j = 0, last = -1; j < m; j++) {
      if (!Number.isNaN(out[j]!)) {
        last = j;
        continue;
      }
      let k = j + 1;
      while (Number.isNaN(out[k]!)) k++;
      out[j] = Math.min(out[last]!, out[k]!);
    }
    return out;
  });

  let sectioned = !!lineCuts || (!straight && grid.count * m <= OUTLINE_TESTS);
  let cuts = 0;
  const samples: EdgeSample[] = wedges.map((w, j) => {
    const sample: EdgeSample = {
      point: w.p,
      tangent: [w.tangent.x, w.tangent.y, w.tangent.z],
      into1: [w.d1.x, w.d1.y, w.d1.z],
      into2: [w.d2.x, w.d2.y, w.d2.z],
      bend1: w.bend1,
      bend2: w.bend2,
      reach1: reaches[0]![j]!,
      reach2: reaches[1]![j]!,
    };
    if (!sectioned) return sample;
    const segs = lineCuts
      ? bodyOutline(body, w.pv, wedges[0]!.tangent, w.d1, w.side1, lineCuts[j])
      : bodyOutline(body, w.pv, w.tangent, w.d1, w.side1);
    if ((cuts += segs.length / 4) > OUTLINE_CUTS) sectioned = false;
    const outline = sectioned && sectionOutline(sample, segs, segs.length / 4, OUTLINE_KEEP / m);
    return outline ? { ...sample, outline } : sample;
  });
  if (!sectioned) {
    for (const [j, s] of samples.entries()) {
      const { outline: _, ...bare } = s;
      samples[j] = bare;
    }
  }

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

export { resampleEdge, facesAtPoint, edgeFaceSamples, bodyOutline };
