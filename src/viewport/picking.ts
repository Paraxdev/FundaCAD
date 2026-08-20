// Picking: raycast the mesh (faces) and the fat edge lines (edges), then turn a
// hit into a *selector descriptor* — never a raw index. Axis-aligned geometry
// becomes a robust axis/normal selector; otherwise a nearest-to-point selector.

import * as THREE from "three";
import type { Selector } from "../types";
import type { ModelView } from "./render";
import { bodyOfFace, edgeObjects, faceIdOfHit, visibleBodyMeshes } from "./render";
import type { BodyEdges, EdgeRef } from "./edgeLines";
import { edgeSelectorFrom } from "./edgeMatch";
import { flushRaycastIndex } from "./raycastIndex";
import { BAND_CAP_EXTENT_PX, ScreenExtent, edgeBandPx, sampleIndices } from "./edgeBand";

export interface EdgeHit {
  kind: "edge";
  /** the edge itself — a stable reference, not the object that draws it */
  edge: EdgeRef;
  selector: Selector;
}

export interface FaceHit {
  kind: "face";
  faceId: number;
  selector: Selector;
  /** world-space raycast intersection — a point guaranteed ON the face's
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
  /** ray distance, so a caller can drop the ones behind the surface */
  depth: number;
}

export class Picker {
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private scratch = new THREE.Vector3();
  // screen-space distance (px) of the best edge hit from the last pickEdge() —
  // lets pick() prefer a face over an edge unless the cursor is on the edge line.
  private edgeScreenDist = Infinity;
  // ray distance of that same edge hit, so pick() can tell whether it is on the
  // surface the cursor is over or on the far side of the body. See occludedEdge.
  private edgeDepth = Infinity;
  // Raycast targets: ONE merged object per body now, so this list is ~3k long
  // instead of ~348k and the per-move filter is cheap. Hidden edges are not in
  // the geometry at all (BodyEdges rebuilds without them), so there is nothing
  // per-edge left to filter here — only whole-body visibility.
  private targetCache: { view: ModelView; targets: THREE.Object3D[] } | null = null;
  private edgeTargets(view: ModelView): THREE.Object3D[] {
    if (this.targetCache?.view !== view) {
      const targets = edgeObjects(view).filter((d) => d.pickable).map((d) => d.object);
      this.targetCache = { view, targets };
    }
    return this.targetCache.targets;
  }

  /** Drop the cached raycast targets — call after anything that changes which
   *  bodies or edges are drawn (hideFlushSeams, body show/hide). */
  invalidate() {
    this.targetCache = null;
  }

  /** All pickable (visible) edges — also used for tangent-chain expansion. */
  visibleEdges(view: ModelView): EdgeRef[] {
    return edgeObjects(view).flatMap((d) => d.visibleRefs());
  }

  /** General selection: a face wins over an edge unless the cursor is right on
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
    // raycastIndex.ts). If a pick beats that, build them now: three-mesh-bvh
    // would otherwise fall back to a brute-force scan of every triangle. Free
    // once the queue has drained, which is the normal case.
    flushRaycastIndex();
    const edge = this.pickEdge(clientX, clientY, rect, camera, view);

    this.raycaster.setFromCamera(this.ndc, camera); // ndc set by pickEdge
    // one Mesh per visible body now (not caching this list like visibleEdges —
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

    // edge only when on the line (or there's no face under the cursor at all),
    // and never when that line is round the back of the body
    const through = occludedEdge(this.edgeDepth, fHit?.distance ?? null, modelScale(view));
    // The band shrinks with the face under the cursor, so a small or
    // shallowly-angled face keeps an interior to click. See edgeBand.ts.
    const band = edgeBandPx(
      face && fHit ? faceScreenExtentPx(view, face.faceId, camera, rect) : null,
    );
    if (edge && !through && (this.edgeScreenDist <= band || !face)) return edge;
    return face;
  }

  /** Ray distance to the visible surface under the last-picked point, or null
   *  when the ray misses the model entirely.
   *
   *  Reads the ndc set by the last pickEdge / pickEdgeCandidates rather than
   *  taking coordinates of its own, so a caller cannot accidentally ask about a
   *  different pixel than the one it just gathered candidates for. With no face
   *  there is nothing to be occluded BY, which is a real case: picking an edge
   *  against empty space has to keep working. */
  faceDepthAt(camera: THREE.Camera, view: ModelView): number | null {
    this.raycaster.setFromCamera(this.ndc, camera);
    return this.raycaster.intersectObjects(visibleBodyMeshes(view), false)[0]?.distance ?? null;
  }

  /** Edge-only pick. Returns a precise single-edge (by:nearest) selector — used
   *  by fillet/chamfer where you want exactly the edge you clicked, not its
   *  whole axis group. Also sets this.ndc for a follow-up face pick. */
  pickEdge(
    clientX: number,
    clientY: number,
    rect: DOMRect,
    camera: THREE.Camera,
    view: ModelView,
  ): EdgeHit | null {
    const cands = this.pickEdgeCandidates(clientX, clientY, rect, camera, view);
    const best = cands[0];
    if (!best) return null;
    // Deliberately the whole candidate minus its ranking fields: every existing
    // caller wants an EdgeHit and must not start depending on the distance.
    return { kind: "edge", edge: best.edge, selector: best.selector };
  }

  /** Every edge the cursor could have meant, nearest first in SCREEN space.
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
    // (render.ts) — no per-move sync needed here.
    // skip hidden lines (flush-seam-hidden contact rims, hidden bodies) — the
    // raycaster tests invisible objects too, which would give ghost edge picks
    const eHits = this.raycaster.intersectObjects(this.edgeTargets(view), false);
    this.edgeScreenDist = Infinity;
    this.edgeDepth = Infinity;
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
      if (seen && seen.screenDist <= d) continue;
      const selector = seen?.selector ?? edgeSelectorFrom({ points: edge.points, body: edge.body });
      if (!selector) continue;
      byEdge.set(edge, { kind: "edge", edge, selector, screenDist: d, depth: h.distance });
    }
    const out = [...byEdge.values()].sort((a, b) => a.screenDist - b.screenDist);
    const best = out[0];
    if (best) {
      this.edgeScreenDist = best.screenDist; // used by pick() to decide edge vs face
      this.edgeDepth = best.depth; //  "     "     "  to reject an edge behind it
    }
    return out;
  }
}

/** How far behind the visible surface an edge may sit and still count as being ON
 *  it, as a fraction of the model's size.
 *
 *  Relative because it exists to absorb tessellation error: a curved face's
 *  triangles sit up to a chord's sagitta inside the true surface, so an edge on
 *  that surface can measure marginally behind them, and that error scales with
 *  the geometry that produced it. Small enough that it stays well under the
 *  thickness of a thin plate — on a 100x100x2 plate (141mm diagonal) this is
 *  0.28mm against 2mm of material, so the plate's own back edges are still
 *  rejected. */
export const EDGE_DEPTH_FRACTION = 0.002;

/** Is the best edge candidate round the BACK of the body?
 *
 *  pickEdge deliberately ranks edges by screen distance rather than by depth, so
 *  that a fat line the cursor is visually nearest wins over one that merely
 *  happens to be closer to the camera. That is right among edges you can see and
 *  wrong the moment an edge you cannot see projects near the cursor: hovering
 *  anywhere near the silhouette, an edge on the far side of the solid lands a
 *  couple of pixels from the pointer and takes the pick from the face you are
 *  actually looking at. That is the "it selected through the object" report.
 *
 *  A face hit is the depth of the surface under the cursor, so anything further
 *  than that (plus the tolerance above) is behind material and cannot have been
 *  what the user aimed at. With no face under the cursor there is nothing to be
 *  occluded BY — that is the case where you pick an edge against empty space,
 *  and it must keep working. */
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

/** The model's overall size, for the tolerance above. Zero for an empty view,
 *  which occludedEdge reads as "use the absolute floor". */
function modelScale(view: ModelView): number {
  const d = view.box.isEmpty() ? 0 : view.box.getSize(new THREE.Vector3()).length();
  return Number.isFinite(d) ? d : 0;
}

// three.js Line2 raycast threshold is ~0.5× the on-screen pixel radius, so ~26
// gives a comfortable ~13px grab radius. Candidates are then narrowed by screen
// distance (see pickEdge), so a wide value stays precise.
const EDGE_PICK_THRESHOLD = 26;
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
