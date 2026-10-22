// A hit becomes a selector descriptor, never a raw index: an axis or normal selector for axis aligned
// geometry, else a nearest to point selector.

import * as THREE from "three";
import type { Selector } from "../types";
import type { ModelView } from "./render";
import { bodyOfFace, edgeObjects, faceIdOfHit, visibleBodyMeshes } from "./render";
import type { BodyEdges, EdgeRef } from "./edgeLines";
import { edgeSelectorFrom } from "./edgeMatch";
import { flushRaycastIndex } from "./raycastIndex";
import { firstKeptHit, keptPoint, SECTION_PICK_SLACK } from "./sectionPick";
import { hitScale } from "../input/pointerKind";
import { overlayLayer } from "./overlayKinds";
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
  edge: EdgeRef;
  selector: Selector;
}

export interface FaceHit {
  kind: "face";
  faceId: number;
  selector: Selector;
  /** World space raycast hit, which is ON the face (a holed face's centroid may not be). */
  point: [number, number, number];
}

export type Hit = EdgeHit | FaceHit;

/** Shift sets both, but Ctrl adds without meaning "no tangent chain"; reducing the pair to one boolean at
 *  the call site is how the two came to disagree. */
export interface PickMods {
  /** Ctrl / Cmd / Shift: add to the selection instead of replacing it. */
  additive: boolean;
  /** Shift on an EDGE: exactly this one, no tangent chain (see pickScope.ts). */
  exact: boolean;
}

/** Keeps the runners up pickEdge throws away: when two edges are the same distance from the cursor, the
 *  runner up is the other half of a question (viewport/edgeTies.ts). */
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

function edgeLayer<T extends THREE.Raycaster>(r: T): T {
  r.layers.enable(overlayLayer("edges"));
  return r;
}

export class Picker {
  // firstHitOnly (three-mesh-bvh, ignored by line picks) skips sorting every hit through an assembly, most of a
  // pick's cost. The edges' layer is always tested, so an outline hidden from the view still selects its edge.
  private raycaster = edgeLayer(Object.assign(new THREE.Raycaster(), { firstHitOnly: true }));
  private ndc = new THREE.Vector2();
  private scratch = new THREE.Vector3();
  // One merged object per body (~3k targets, not ~348k), and hidden edges are not in the geometry
  // (BodyEdges rebuilds without them), so only whole body visibility is filtered here.
  private targetCache: { view: ModelView; targets: THREE.Object3D[] } | null = null;
  private edgeTargets(view: ModelView): THREE.Object3D[] {
    if (this.targetCache?.view !== view) {
      const targets = edgeObjects(view)
        .filter((d) => d.pickable)
        .map((d) => d.object);
      this.targetCache = { view, targets };
    }
    return this.targetCache.targets;
  }

  private clip: THREE.Plane | null = null;
  /** The section cut picks honour, held by reference so a dragged cut needs no call; null for none. */
  setClip(plane: THREE.Plane | null) {
    this.clip = plane;
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

  /** A face is preferred over an edge unless the cursor is right on the edge line (EDGE_NEAR_PX). The
   *  edge tools call pickEdgeAt() directly and keep the generous EDGE_PICK_THRESHOLD radius. */
  pick(clientX: number, clientY: number, rect: DOMRect, camera: THREE.Camera, view: ModelView): Hit | null {
    // Body BVHs are built after the first paint (raycastIndex.ts); a pick before that would make
    // three-mesh-bvh brute force every triangle. Free once the queue has drained.
    flushRaycastIndex();
    const cands = this.pickEdgeCandidates(clientX, clientY, rect, camera, view);

    this.raycaster.setFromCamera(this.ndc, camera); // ndc set by pickEdgeCandidates
    const scale = modelScale(view);
    const kept = firstKeptHit(this.raycaster, visibleBodyMeshes(view), this.clip, SECTION_PICK_SLACK * scale);
    const fHit = kept && !kept.cap ? kept.hit : undefined;
    let face: FaceHit | null = null;
    if (fHit) {
      const faceId = faceIdOfHit(fHit);
      const point = fHit.point.clone();
      const normal = fHit.normal?.clone().transformDirection(fHit.object.matrixWorld) ?? new THREE.Vector3(0, 0, 1);
      face = { kind: "face", faceId, selector: faceSelector(normal, point), point: [point.x, point.y, point.z] };
    }

    if (!cands.length) return face;
    // Never an edge round the back of the body. The band follows the face under the cursor (edgeBand.ts) and is
    // scaled after it is measured, so the early exit at BAND_CAP_EXTENT_PX still means "capped" for a finger.
    const faceBand = edgeBandPx(face ? faceScreenExtentPx(view, face.faceId, camera, rect) : null) * hitScale();
    // Over a face only candidates within a few px of the pointer get a sight
    // ray, so the bodies near the ray are gathered for the radius asked so far.
    let near: THREE.Mesh[] = [];
    let nearPx = 0;
    const occluders = (px: number) => {
      if (px > nearPx) near = this.occludersNear((nearPx = Math.max(px, 2 * nearPx, 4)), camera, rect, view);
      return near;
    };
    const i = preferredEdge(
      cands.map((c) => ({
        screenDist: c.screenDist,
        occluded: () => !this.pointVisible(c.point, camera, occluders(c.screenDist + 1), scale),
        bandPx: () =>
          edgeBandForPx(
            faceBand,
            c.edge.smooth ? 0 : shortEdgeBoostPx(edgeScreenLengthPx(c.edge, camera, rect)) * hitScale(),
            c.edge.smooth,
          ),
      })),
      !!face,
    );
    const edge = i == null ? undefined : cands[i];
    return edge ? { kind: "edge", edge: edge.edge, selector: edge.selector } : face;
  }

  /** For the edge tools: the best ranked edge within the whole grab radius, faces never compete. `visibleOnly`
   *  is off in see through views, where back edges are drawn. Also sets this.ndc for a follow up face pick. */
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
    const near = this.occludersNear(farthestPx(cands), camera, rect, view);
    return cands.find((c) => this.pointVisible(c.point, camera, near, scale)) ?? null;
  }

  /** The candidates whose nearest point is in plain view. */
  visibleCandidates(cands: EdgeCandidate[], camera: THREE.Camera, view: ModelView, rect: DOMRect): EdgeCandidate[] {
    const scale = modelScale(view);
    const near = this.occludersNear(farthestPx(cands), camera, rect, view);
    return cands.filter((c) => this.pointVisible(c.point, camera, near, scale));
  }

  /** A sight ray otherwise walks every body: 0.29 ms on a 1310 body assembly against 0.05 ms through the 78
   *  within 5 px, and a pick over a dense one asks over a thousand of them. */
  private occludersNear(radiusPx: number, camera: THREE.Camera, rect: DOMRect, view: ModelView): THREE.Mesh[] {
    return meshesNearRay(visibleBodyMeshes(view), this.raycaster.ray, camera, rect.height, radiusPx);
  }

  private sightRay = Object.assign(new THREE.Raycaster(), { firstHitOnly: true });
  private sightNdc = new THREE.Vector2();

  /** Asked at the edge's own point, not under the cursor: across a wide grab radius, as beside a silhouette,
   *  the face under the cursor can sit in front of an edge that is in plain view. */
  private pointVisible(point: THREE.Vector3, camera: THREE.Camera, meshes: THREE.Mesh[], scale: number): boolean {
    const p = this.scratch.copy(point).project(camera);
    this.sightRay.setFromCamera(this.sightNdc.set(p.x, p.y), camera);
    const kept = firstKeptHit(this.sightRay, meshes, this.clip, SECTION_PICK_SLACK * scale);
    return !occludedEdge(this.sightRay.ray.origin.distanceTo(point), kept?.distance ?? null, scale);
  }

  /** Ranked in screen space, not by depth, so the edge the cursor sits on beats a nearer one, and a smooth
   *  edge is pushed back (edgeRankPx). One entry per edge, not per segment hit, at its closest approach. */
  pickEdgeCandidates(
    clientX: number,
    clientY: number,
    rect: DOMRect,
    camera: THREE.Camera,
    view: ModelView,
  ): EdgeCandidate[] {
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, camera);
    // Line2's threshold is ~0.5x screen px, so this is a forgiving grab radius. Set per pick because the
    // pointer in use, and so the finger size, can change between two moves.
    this.raycaster.params.Line2 = { threshold: EDGE_PICK_THRESHOLD * hitScale() };
    (this.raycaster as any).camera = camera;
    // edgeTargets skips hidden lines, since the raycaster tests invisible objects too. LineMaterial.resolution
    // is synced on resize and at creation (render.ts), not per move.
    const targets = legibleEdgeTargets(
      this.edgeTargets(view),
      this.raycaster.ray,
      camera,
      rect.height,
      EDGE_PICK_THRESHOLD * hitScale(),
    );
    const eHits = this.raycaster.intersectObjects(targets, false);
    if (!eHits.length) return [];
    // Line2 ignores the raycaster's near and far, so an edge is kept or dropped by its point nearest the ray.
    const slack = SECTION_PICK_SLACK * modelScale(view);

    const byEdge = new Map<EdgeRef, EdgeCandidate>();
    for (const h of eHits) {
      // three reports the instance (segment) index as `faceIndex` on a
      // LineSegments2 hit; the owning BodyEdges maps it back to the edge.
      const draw = h.object.userData.edges as BodyEdges | undefined;
      const edge = draw?.refAtSegment(h.faceIndex ?? -1);
      if (!edge) continue;
      const p = (h as any).pointOnLine ?? h.point;
      if (this.clip && !keptPoint(p, this.clip, slack)) continue;
      this.scratch.copy(p).project(camera);
      const sx = (this.scratch.x * 0.5 + 0.5) * rect.width + rect.left;
      const sy = (-this.scratch.y * 0.5 + 0.5) * rect.height + rect.top;
      const d = Math.hypot(sx - clientX, sy - clientY);
      const seen = byEdge.get(edge);
      // Within a pixel, the stretch nearer the camera: a circle seen edge on draws its front and back
      // halves on the same line, and only the front one can be under the cursor.
      if (seen && (seen.screenDist < d - 1 || (seen.screenDist <= d + 1 && seen.depth <= h.distance))) continue;
      const selector = seen?.selector ?? edgeSelectorFrom({ points: edge.points, body: edge.body });
      if (!selector) continue;
      byEdge.set(edge, {
        kind: "edge",
        edge,
        selector,
        screenDist: d,
        rankPx: edgeRankPx(d, edge.smooth),
        depth: h.distance,
        point: p.clone(),
      });
    }
    return [...byEdge.values()].sort((a, b) => a.rankPx - b.rankPx);
  }
}

/** A screen radius that holds every candidate, a px of slack for rounding. */
function farthestPx(cands: readonly EdgeCandidate[]): number {
  let px = 0;
  for (const c of cands) px = Math.max(px, c.screenDist);
  return px + 1;
}

const _sphere = new THREE.Sphere();
const _onRay = new THREE.Vector3();

/** World size of one screen pixel: `fixed` (orthographic) plus `perDepth` times the depth (perspective). Null for a
 *  camera of neither kind. */
function pixelSize(camera: THREE.Camera, viewHeightPx: number): { fixed: number; perDepth: number } | null {
  const persp = camera as THREE.PerspectiveCamera;
  const ortho = camera as THREE.OrthographicCamera;
  if (persp.isPerspectiveCamera) {
    return {
      fixed: 0,
      perDepth: (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)) / (persp.zoom * viewHeightPx),
    };
  }
  if (ortho.isOrthographicCamera)
    return { fixed: (ortho.top - ortho.bottom) / (ortho.zoom * viewHeightPx), perDepth: 0 };
  return null;
}

/** The object's bounding sphere in world space, in the shared scratch sphere. */
function worldSphere(o: THREE.Object3D & { geometry: THREE.BufferGeometry }): THREE.Sphere {
  const g = o.geometry;
  if (!g.boundingSphere) g.computeBoundingSphere();
  return _sphere.copy(g.boundingSphere!).applyMatrix4(o.matrixWorld);
}

/** Whether a sphere comes within `radiusPx` on screen of the pointer ray. */
function sphereNearRay(s: THREE.Sphere, ray: THREE.Ray, px: { fixed: number; perDepth: number }, radiusPx: number) {
  const away = ray.closestPointToPoint(s.center, _onRay).distanceTo(s.center);
  const reach = radiusPx * (px.fixed + px.perDepth * (ray.origin.distanceTo(s.center) + s.radius));
  return away <= s.radius + reach;
}

/** Conservative: a point drawn that close to the pointer lies within that screen distance per unit of
 *  ray depth (perspective) or a fixed world distance (orthographic), and depth never exceeds distance. */
export function meshesNearRay(
  meshes: readonly THREE.Mesh[],
  ray: THREE.Ray,
  camera: THREE.Camera,
  viewHeightPx: number,
  radiusPx: number,
): THREE.Mesh[] {
  const px = pixelSize(camera, viewHeightPx);
  if (!px) return [...meshes];
  return meshes.filter((m) => sphereNearRay(worldSphere(m), ray, px, radiusPx));
}

/** Edge segments per pixel of a body's drawn disc above which a pick skips its edges. Past one segment a pixel the
 *  nearest one is a matter of rounding, and a zoomed out 12 M triangle assembly put 117k segment hits under the grab
 *  radius, a hover of up to 1.1 s per pointer move. */
export const EDGE_PICK_MAX_DENSITY = 1;

/** The edge objects a pick at `ray` tests: those within `radiusPx` of it on screen whose segments are drawn far enough
 *  apart to tell one from the next. A body skipped here is still hovered and picked by its faces. */
export function legibleEdgeTargets(
  targets: readonly THREE.Object3D[],
  ray: THREE.Ray,
  camera: THREE.Camera,
  viewHeightPx: number,
  radiusPx: number,
): THREE.Object3D[] {
  const px = pixelSize(camera, viewHeightPx);
  if (!px) return [...targets];
  const out: THREE.Object3D[] = [];
  for (const o of targets) {
    const g = (o as THREE.Object3D & { geometry?: THREE.BufferGeometry }).geometry;
    if (!g) {
      out.push(o);
      continue;
    }
    const s = worldSphere(o as THREE.Object3D & { geometry: THREE.BufferGeometry });
    if (!sphereNearRay(s, ray, px, radiusPx)) continue;
    const segments = (g.getAttribute("instanceStart") as THREE.BufferAttribute | undefined)?.count;
    const depth = ray.origin.distanceTo(s.center);
    const pxPerWorld = 1 / (px.fixed + px.perDepth * depth);
    // A camera inside the sphere sees the body fill the view.
    const discPx = depth <= s.radius && px.perDepth > 0 ? Infinity : Math.PI * (s.radius * pxPerWorld) ** 2;
    if (segments === undefined || segments <= EDGE_PICK_MAX_DENSITY * discPx) out.push(o);
  }
  return out;
}

/** Relative, because it absorbs tessellation error, which scales with the geometry. A 100x100x2 plate gets
 *  0.28mm against 2mm of material, so the plate's own back edges are still rejected. */
export const EDGE_DEPTH_FRACTION = 0.002;

/** Edges rank by screen distance, so near a silhouette an edge behind the solid could take the pick ("it
 *  selected through the object"). With no surface on its sight line an edge against empty space still counts. */
export function occludedEdge(edgeDist: number, faceDist: number | null, modelScale: number): boolean {
  if (faceDist == null || !Number.isFinite(edgeDist)) return false;
  const s = Number.isFinite(modelScale) && modelScale > 0 ? modelScale : 0;
  return edgeDist > faceDist + Math.max(1e-6, s * EDGE_DEPTH_FRACTION);
}

/** A ceiling for the pathological case, not a typical cost: one hex textured face owns over 50,000 triangles. */
const FACE_SAMPLE_BUDGET = 256;

/** Samples across the faceId to triangle map rather than taking a prefix, see sampleIndices. */
function faceScreenExtentPx(view: ModelView, faceId: number, camera: THREE.Camera, rect: DOMRect): number | null {
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
      p.fromBufferAttribute(pos as THREE.BufferAttribute, v)
        .applyMatrix4(world)
        .project(camera);
      box.add((p.x + 1) * halfW, (1 - p.y) * halfH);
    }
    // Past the cap the band is the plain constant whatever else this face does,
    // so more measurement cannot change the answer.
    if (box.min >= BAND_CAP_EXTENT_PX) return box.min;
  }
  return box.measured ? box.min : null;
}

/** The larger side, since an edge straight across the screen has a zero width box; both are tiny only for an
 *  edge seen nearly end on. Through the drawing object's matrixWorld, as the raycast that found it was. */
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
export function modelScale(view: ModelView): number {
  const d = view.box.isEmpty() ? 0 : view.box.getSize(new THREE.Vector3()).length();
  return Number.isFinite(d) ? d : 0;
}

// Line2's raycast threshold is ~0.5x the on screen pixel radius, so this grabs EDGE_GRAB_PX either side
// of the line at any zoom. Candidates are ranked by screen distance, so a wide value stays precise.
const EDGE_PICK_THRESHOLD = 2 * EDGE_GRAB_PX;
// The edge versus face band lives in edgeBand.ts; Fillet and Chamfer (pickEdgeAt) ignore it.

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
