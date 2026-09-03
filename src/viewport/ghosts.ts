// The previews a drag paints before the kernel has said anything.
//
// Split out of viewport.ts. Every one of these is the same bargain: a rebuild
// through the sidecar is exact and takes long enough that a drag would lurch,
// so the frontend draws what the result is going to be and the real feature is
// committed on release. Nothing here ever reaches the document.
//
// Three of them, and they are different KINDS of cheat:
//
//   - press/pull builds new geometry (a prism raised off the picked faces), so
//     it is a mesh of its own that is thrown away on commit;
//   - a move touches no geometry at all — a rigid transform is a matrix on the
//     body objects, zero vertex writes, and picking follows it because raycasts
//     read matrixWorld;
//   - a pattern is the move trick N times over, drawn as cloned meshes.
//
// The move ghost is the one with a real hand-off: on commit the offset STAYS
// until the rebuilt body arrives, because dropping it would snap the part back
// for the frame or two the round trip takes.

import * as THREE from "three";
import { radialAt } from "../features/planeMath";
import type { RoundFace } from "../features/radialDrag";
import { bodyOfFace, type BodyEdges, type BodyMesh, type ModelView } from "./render";
import { themeColor } from "./themeColors";

/** The slice of Viewport these previews need — live accessors, not copies. */
export interface GhostHost {
  /** the current model, or null between builds */
  model(): ModelView | null;
  addToScene(obj: THREE.Object3D): void;
  removeFromScene(obj: THREE.Object3D): void;
  requestRender(): void;
  /** a picked face's outward normal in world space, for the flat press/pull */
  faceNormalWorld(faceId: number): THREE.Vector3;
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
      opacity: 0.4,
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

  // --- Move ghost: translate the selected bodies' mesh + edges live during a drag,
  // with NO sidecar rebuild (a rigid move needs no geometry recompute) — so dragging
  // is snappy. The real `move` feature is committed on release. With per-body meshes
  // this is a pure object-transform offset: zero vertex writes, zero GPU uploads.
  // Raycasts (bodyIdAt, pointInSolid parity) follow matrixWorld, refreshed eagerly
  // on every offset so picking never lags the visual. On commit (restore=false) the
  // offset stays until the rebuilt body arrives; the moved body's etag changes, so
  // setModel replaces its mesh (position 0) — and resetBodyAppearance() clears any
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
  // The copies share the source body's geometry buffers — a ghost is a second
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
