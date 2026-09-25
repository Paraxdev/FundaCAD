// Picking: raycast the mesh (faces) and the fat edge lines (edges), then turn a
// hit into a *selector descriptor*, never a raw index. Axis-aligned geometry
// becomes a robust axis/normal selector; otherwise a nearest-to-point selector.

import * as THREE from "three";
import type { Selector } from "../types";
import type { ModelView } from "./render";
import { bodyOfFace, edgeObjects, faceIdOfHit, visibleBodyMeshes } from "./render";
import type { BodyEdges, EdgeRef } from "./edgeLines";
import { edgeSelectorFrom } from "./edgeMatch";
import { flushRaycastIndex } from "./raycastIndex";
import {
  BAND_CAP_EXTENT_PX,
  ScreenExtent,
  edgeBandForPx,
  EDGE_GRAB_PX,
  edgeBandPx,
  edgeRankPx,
  preferredEdge,
  sampleIndices,
  shortEdgeBoostPx,
} from "./edgeBand";

export interface EdgeHit {
  kind: "edge";
  /** the edge itself, a stable reference, not the object that draws it */
  edge: EdgeRef;
  selector: Selector;
}

export interface FaceHit {
  kind: "face";
  faceId: number;
  selector: Selector;
  /** world-space raycast intersection, a point guaranteed ON the face's
   *  material (its centroid may not be: annular/holed faces). */
  point: [number, number, number];
}

export type Hit = EdgeHit | FaceHit;

/** What the modifier keys meant, once, so every consumer reads the same rule.
 *
 *  `additive` and `exact` are not the same flag even though Shift sets both:
 *  Ctrl adds without meaning "no tangent chain", and reducing the pair to one
 *  boolean at the call site is how the two came to disagree. */
export interface PickMods {
  /** Ctrl / Cmd / Shift: add to the selection instead of replacing it. */
  additive: boolean;
  /** Shift on an EDGE: exactly this one, no tangent chain (see pickScope.ts). */
  exact: boolean;
}

/** One edge the cursor could have meant, with how far off it landed.
 *
 *  pickEdge answers "which edge" and throws the runners-up away; this keeps
 *  them, because when two edges are the same distance from the cursor the
 *  runner-up is not a worse answer, it is the other half of a question. See
 *  viewport/edgeTies.ts. */
export interface EdgeCandidate extends EdgeHit {
  /** distance from the cursor to this edge, in screen px */
  screenDist: number;
  /** what candidates are ordered by: screenDist, pushed back for a smooth edge (edgeRankPx) */
  rankPx: number;
  /** ray distance, so a caller can drop the ones behind the surface */
  depth: number;
  /** the point on the edge nearest the cursor, world space */
  point: THREE.Vector3;
}

export class Picker {
  // firstHitOnly is read by three-mesh-bvh: every mesh query here wants only the
  // nearest face, and collecting every hit along the ray through a whole
  // assembly only to sort and drop them was most of a pick's cost. Line picks
  // ignore the flag.
  private raycaster = Object.assign(new THREE.Raycaster(), { firstHitOnly: true });
  private ndc = new THREE.Vector2();
  private scratch = new THREE.Vector3();
  // Raycast targets: ONE merged object per body now, so this list is ~3k long
  // instead of ~348k and the per-move filter is cheap. Hidden edges are not in
  // the geometry at all (BodyEdges rebuilds without them), so there is nothing
  // per-edge left to filter here, only whole-body visibility.
  private targetCache: { view: ModelView; targets: THREE.Object3D[] } | null = null;
  private edgeTargets(view: ModelView): THREE.Object3D[] {
    if (this.targetCache?.view !== view) {
      const targets = edgeObjects(view).filter((d) => d.pickable).map((d) => d.object);
      this.targetCache = { view, targets };
    }
    return this.targetCache.targets;
  }

  /** Drop the cached raycast targets, call after anything that changes which
   *  bodies or edges are drawn (hideFlushSeams, body show/hide). */
  invalidate() {
    this.targetCache = null;
  }

  /** All pickable (visible) edges, also used for tangent-chain expansion. */
  visibleEdges(view: ModelView): EdgeRef[] {
    return edgeObjects(view).flatMap((d) => d.visibleRefs());
  }

  /** General selection: a face is preferred over an edge unless the cursor is right on
   *  the edge line (within EDGE_NEAR_PX). The dedicated edge tools call
   *  pickEdgeAt() directly and keep the generous EDGE_PICK_THRESHOLD radius. */
  pick(
    clientX: number,
    clientY: number,
    rect: DOMRect,
    camera: THREE.Camera,
    view: ModelView,
  ): Hit | null {
    // Body BVHs are built after the first paint, not during setModel (see
    // raycastIndex.ts). If a pick arrives before that, build them now: three-mesh-bvh
    // would otherwise fall back to a brute-force scan of every triangle. Free
    // once the queue has drained, which is the normal case.
    flushRaycastIndex();
    const cands = this.pickEdgeCandidates(clientX, clientY, rect, camera, view);

    this.raycaster.setFromCamera(this.ndc, camera); // ndc set by pickEdgeCandidates
    // one Mesh per visible body now (not caching this list like visibleEdges,
    // body counts are small, unlike edge counts, so a per-move filter is cheap).
    const fHits = this.raycaster.intersectObjects(visibleBodyMeshes(view), false);
    const fHit = fHits[0];
    let face: FaceHit | null = null;
    if (fHit) {
      const faceId = faceIdOfHit(fHit);
      const point = fHit.point.clone();
      const normal =
        fHit.normal?.clone().transformDirection(fHit.object.matrixWorld) ??
        new THREE.Vector3(0, 0, 1);
      face = { kind: "face", faceId, selector: faceSelector(normal, point), point: [point.x, point.y, point.z] };
    }

    if (!cands.length) return face;
    // An edge only when the cursor is on its line (or there is no face under the
    // cursor at all), and never one round the back of the body. The band
    // shrinks with the face under the cursor, so a small or shallowly-angled
    // face keeps an interior to click, widens for an edge foreshortened toward
    // a point, and all but closes for a smooth edge. See edgeBand.ts.
    const faceBand = edgeBandPx(face ? faceScreenExtentPx(view, face.faceId, camera, rect) : null);
    const scale = modelScale(view);
    const i = preferredEdge(cands.map((c) => ({
      screenDist: c.screenDist,
      occluded: !this.pointVisible(c.point, camera, view, scale),
      bandPx: edgeBandForPx(
        faceBand,
        c.edge.smooth ? 0 : shortEdgeBoostPx(edgeScreenLengthPx(c.edge, camera, rect)),
        c.edge.smooth,
      ),
    })), !!face);
    const edge = i == null ? undefined : cands[i];
    return edge ? { kind: "edge", edge: edge.edge, selector: edge.selector } : face;
  }

  /** Edge-only pick, the edge tools' (fillet, chamfer, an axis pick): the
   *  best-ranked edge within the whole grab radius, faces never compete.
   *  `visibleOnly` drops edges round the back of the body, off in see-through
   *  views where those edges are drawn. Also sets this.ndc for a follow-up
   *  face pick. */
  pickEdge(
    clientX: number,
    clientY: number,
    rect: DOMRect,
    camera: THREE.Camera,
    view: ModelView,
    opts?: { visibleOnly?: boolean },
  ): EdgeCandidate | null {
    const cands = this.pickEdgeCandidates(clientX, clientY, rect, camera, view);
    if (!cands.length) return null;
    if (!opts?.visibleOnly) return cands[0] ?? null;
    const scale = modelScale(view);
    return cands.find((c) => this.pointVisible(c.point, camera, view, scale)) ?? null;
  }

  /** The candidates whose nearest point is in plain view. */
  visibleCandidates(cands: EdgeCandidate[], camera: THREE.Camera, view: ModelView): EdgeCandidate[] {
    const scale = modelScale(view);
    return cands.filter((c) => this.pointVisible(c.point, camera, view, scale));
  }

  private sightRay = Object.assign(new THREE.Raycaster(), { firstHitOnly: true });
  private sightNdc = new THREE.Vector2();

  /** Whether nothing solid stands between the camera and `point`. Asked at the
   *  edge's own point rather than under the cursor: across a wide grab radius
   *  the face under the cursor can sit well in front of an edge on it, as
   *  beside a silhouette, and would hide an edge that is in plain view. */
  private pointVisible(point: THREE.Vector3, camera: THREE.Camera, view: ModelView, scale: number): boolean {
    const p = this.scratch.copy(point).project(camera);
    this.sightRay.setFromCamera(this.sightNdc.set(p.x, p.y), camera);
    const hit = this.sightRay.intersectObjects(visibleBodyMeshes(view), false)[0];
    return !occludedEdge(this.sightRay.ray.origin.distanceTo(point), hit?.distance ?? null, scale);
  }

  /** Every edge the cursor could have meant, nearest first in SCREEN space,
   *  a smooth edge pushed back (edgeRankPx).
   *
   *  Screen space rather than depth: the raycaster sorts by distance from the
   *  camera, which would rank a front edge above one the cursor is visually
   *  sitting on. Among edges you can see, "nearest the pointer" is the question
   *  being asked.
   *
   *  Distinct EDGES, not raycast hits. One edge is many line segments and a wide
   *  threshold catches several of them, so the raw hit list is mostly the same
   *  edge over and over; a chooser built on that would offer the same entry six
   *  times. Each edge keeps its own closest approach. */
  pickEdgeCandidates(
    clientX: number,
    clientY: number,
    rect: DOMRect,
    camera: THREE.Camera,
    view: ModelView,
  ): EdgeCandidate[] {
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, camera);
    // Wide candidate threshold (three.js Line2 threshold is ~0.5× screen px, so
    // this is a forgiving grab radius).
    this.raycaster.params.Line2 = { threshold: EDGE_PICK_THRESHOLD };
    (this.raycaster as any).camera = camera;
    // NOTE: each LineMaterial's .resolution is kept in sync by
    // setEdgeResolution() on resize, and set at creation time in buildBodyMesh()
    // (render.ts), no per-move sync needed here.
    // skip hidden lines (flush-seam-hidden contact rims, hidden bodies), the
    // raycaster tests invisible objects too, which would give ghost edge picks
    const eHits = this.raycaster.intersectObjects(this.edgeTargets(view), false);
    if (!eHits.length) return [];

    const byEdge = new Map<EdgeRef, EdgeCandidate>();
    for (const h of eHits) {
      // three reports the instance (segment) index as `faceIndex` on a
      // LineSegments2 hit; the owning BodyEdges maps it back to the edge.
      const draw = h.object.userData.edges as BodyEdges | undefined;
      const edge = draw?.refAtSegment(h.faceIndex ?? -1);
      if (!edge) continue;
      const p = (h as any).pointOnLine ?? h.point;
      this.scratch.copy(p).project(camera);
      const sx = (this.scratch.x * 0.5 + 0.5) * rect.width + rect.left;
      const sy = (-this.scratch.y * 0.5 + 0.5) * rect.height + rect.top;
      const d = Math.hypot(sx - clientX, sy - clientY);
      const seen = byEdge.get(edge);
      // Within a pixel, the stretch nearer the camera: a circle seen edge-on
      // draws its front and back halves on the same line, and only the front
      // one can be what the cursor is on.
      if (seen && (seen.screenDist < d - 1 || (seen.screenDist <= d + 1 && seen.depth <= h.distance))) continue;
      const selector = seen?.selector ?? edgeSelectorFrom({ points: edge.points, body: edge.body });
      if (!selector) continue;
      byEdge.set(edge, {
        kind: "edge", edge, selector, screenDist: d, rankPx: edgeRankPx(d, edge.smooth), depth: h.distance, point: p.clone(),
      });
    }
    return [...byEdge.values()].sort((a, b) => a.rankPx - b.rankPx);
  }
}

/** How far behind the visible surface an edge may sit and still count as being ON
 *  it, as a fraction of the model's size.
 *
 *  Relative because it exists to absorb tessellation error: a curved face's
 *  triangles sit up to a chord's sagitta inside the true surface, so an edge on
 *  that surface can measure marginally behind them, and that error scales with
 *  the geometry that produced it. Small enough that it stays well under the
 *  thickness of a thin plate, on a 100x100x2 plate (141mm diagonal) this is
 *  0.28mm against 2mm of material, so the plate's own back edges are still
 *  rejected. */
export const EDGE_DEPTH_FRACTION = 0.002;

/** Is the best edge candidate round the BACK of the body?
 *
 *  pickEdge deliberately ranks edges by screen distance rather than by depth, so
 *  that a fat line the cursor is visually nearest is preferred over one that merely
 *  happens to be closer to the camera. That is right among edges you can see and
 *  wrong the moment an edge you cannot see projects near the cursor: hovering
 *  anywhere near the silhouette, an edge on the far side of the solid lands a
 *  couple of pixels from the pointer and takes the pick from the face you are
 *  actually looking at. That is the "it selected through the object" report.
 *
 *  `faceDist` is the first surface on the sight line to the edge's own nearest
 *  point (Picker.pointVisible), so an edge further than that (plus the
 *  tolerance above) is behind material and cannot have been what the user
 *  aimed at. Asked at the edge rather than under the cursor: beside a
 *  silhouette the face under the cursor sits in front of the edge it ends at.
 *  With no surface on that line there is nothing to be occluded BY, and an
 *  edge picked against empty space must keep working. */
export function occludedEdge(
  edgeDist: number,
  faceDist: number | null,
  modelScale: number,
): boolean {
  if (faceDist == null || !Number.isFinite(edgeDist)) return false;
  const s = Number.isFinite(modelScale) && modelScale > 0 ? modelScale : 0;
  return edgeDist > faceDist + Math.max(1e-6, s * EDGE_DEPTH_FRACTION);
}

/** How many triangles of a face to look at. Generous, because the samples are
 *  spread and the early exit fires long before this on anything large: it is a
 *  ceiling for the pathological case, not a typical cost. One hex-textured face
 *  in this app owns over 50,000 triangles. */
const FACE_SAMPLE_BUDGET = 256;

/** The smaller on-screen side of a face, in px, or null if it cannot be
 *  measured.
 *
 *  Reads the precomputed faceId -> triangle map rather than re-deriving one, and
 *  SAMPLES across it rather than taking a prefix: see sampleIndices for why that
 *  distinction decides whether a large face measures as large. */
function faceScreenExtentPx(
  view: ModelView,
  faceId: number,
  camera: THREE.Camera,
  rect: DOMRect,
): number | null {
  const body = bodyOfFace(view, faceId);
  const tris = body?.faceTriangles.get(faceId);
  if (!body || !tris || tris.length === 0) return null;
  const geom = body.mesh.geometry;
  const index = geom.getIndex();
  const pos = geom.getAttribute("position");
  if (!index || !pos) return null;

  const world = body.mesh.matrixWorld;
  const box = new ScreenExtent();
  const p = new THREE.Vector3();
  const halfW = rect.width / 2;
  const halfH = rect.height / 2;
  for (const t of sampleIndices(tris.length, FACE_SAMPLE_BUDGET)) {
    const tri = tris[t];
    if (tri === undefined) continue;
    for (let k = 0; k < 3; k++) {
      const v = index.getX(tri * 3 + k);
      p.fromBufferAttribute(pos as THREE.BufferAttribute, v).applyMatrix4(world).project(camera);
      box.add((p.x + 1) * halfW, (1 - p.y) * halfH);
    }
    // Past the cap the band is the plain constant whatever else this face does,
    // so more measurement cannot change the answer.
    if (box.min >= BAND_CAP_EXTENT_PX) return box.min;
  }
  return box.measured ? box.min : null;
}

/** The larger on-screen side of one edge's own bounding box, in px, or null if
 *  it has no points. An edge foreshortened toward a point, viewed nearly
 *  end-on, projects to a tiny box in both directions; an ordinary one does not,
 *  so this stays large and shortEdgeBoostPx leaves it alone. The larger side,
 *  because an edge running straight across or down the screen has a box of
 *  zero width however long it is. Transformed through the drawing object's own
 *  matrixWorld, the same one the raycast that found it was tested against,
 *  rather than assuming edge.points is world-space. */
function edgeScreenLengthPx(edge: EdgeRef, camera: THREE.Camera, rect: DOMRect): number | null {
  if (!edge.points.length) return null;
  const world = edge.draw.object.matrixWorld;
  const box = new ScreenExtent();
  const p = new THREE.Vector3();
  const halfW = rect.width / 2;
  const halfH = rect.height / 2;
  for (const pt of edge.points) {
    p.set(pt[0], pt[1], pt[2]).applyMatrix4(world).project(camera);
    box.add((p.x + 1) * halfW, (1 - p.y) * halfH);
  }
  return box.measured ? box.max : null;
}

/** The model's overall size, for the tolerance above. Zero for an empty view,
 *  which occludedEdge reads as "use the absolute floor". */
function modelScale(view: ModelView): number {
  const d = view.box.isEmpty() ? 0 : view.box.getSize(new THREE.Vector3()).length();
  return Number.isFinite(d) ? d : 0;
}

// three.js Line2 raycast threshold is ~0.5× the on-screen pixel radius, so this
// is a comfortable grab radius of EDGE_GRAB_PX either side of the line, in
// screen px at any zoom. Candidates are then ranked by screen distance (see
// pickEdgeCandidates), so a wide value stays precise.
const EDGE_PICK_THRESHOLD = 2 * EDGE_GRAB_PX;
// The edge-vs-face band lives in edgeBand.ts: it is no longer one number, but
// a fraction of the face being aimed at, capped at EDGE_NEAR_PX so ordinary
// faces pick exactly as before. Fillet/Chamfer (pickEdgeAt) ignore it entirely
// and keep the wide grab radius.

function faceSelector(normal: THREE.Vector3, hit: THREE.Vector3): Selector {
  const n = normal.clone().normalize();
  const near = (v: number, t: number) => Math.abs(v - t) < 1e-3;
  const axisAligned =
    (near(Math.abs(n.x), 1) && near(n.y, 0) && near(n.z, 0)) ||
    (near(Math.abs(n.y), 1) && near(n.x, 0) && near(n.z, 0)) ||
    (near(Math.abs(n.z), 1) && near(n.x, 0) && near(n.y, 0));
  if (axisAligned) {
    return {
      kind: "face",
      by: "normal",
      dir: [round(n.x), round(n.y), round(n.z)],
    };
  }
  return { kind: "face", by: "nearest", point: [hit.x, hit.y, hit.z] };
}

const round = (v: number) => Math.round(v);
