// Move gizmo targets for sketches: the selected entities inside an open sketch,
// and whole sketches (with or without bodies) from the model.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { CadDocument, Feature, PlaneDef, PlaneSpec } from "../types";
import { asFeature } from "../types";
import { planeOf } from "../document/planeOf";
import { SketchPlane } from "../sketch/plane";
import type { SketchOverlay } from "../sketch/overlay";
import type { ResolvedEntity } from "../sketch/snap";
import { entityPolyline } from "../sketch/region";
import { resolveEntities } from "../sketch/resolve";
import { rotated, scaled, translated } from "../sketch/pattern";
import { toast } from "../ui/toast";
import {
  ALL_HANDLES,
  IN_PLANE_HANDLES,
  WORLD_FRAME,
  bodyMoveFeatures,
  type MoveTarget,
} from "./moveTarget";

/** A transform that keeps a plane in itself, read in that plane's 2D coordinates:
 *  p' = f · R(angle) · p + (tx, ty). */
export interface Similarity2D {
  f: number;
  angle: number;
  tx: number;
  ty: number;
}

export function similarityIn(plane: SketchPlane, m: THREE.Matrix4): Similarity2D {
  const o = plane.origin.clone().applyMatrix4(m);
  const ux = plane.origin.clone().add(plane.u).applyMatrix4(m).sub(o);
  const t = plane.to2D(o);
  const c = ux.dot(plane.u), s = ux.dot(plane.v);
  return { f: Math.hypot(c, s), angle: Math.atan2(s, c), tx: t.x, ty: t.y };
}

/** One entity under a similarity. A rotation turns a rectangle into four lines,
 *  as the sketch Rotate tool already does. */
export function transformEntity(e: ResolvedEntity, sim: Similarity2D, id: string): ResolvedEntity[] {
  let out: ResolvedEntity[] = [e];
  if (Math.abs(sim.f - 1) > 1e-9) out = out.map((x) => scaled(x, 0, 0, sim.f, id));
  if (Math.abs(sim.angle) > 1e-9) out = out.flatMap((x) => rotated(x, 0, 0, sim.angle, id));
  if (Math.abs(sim.tx) > 1e-9 || Math.abs(sim.ty) > 1e-9) out = out.map((x) => translated(x, sim.tx, sim.ty, id));
  return out.map((x) => (x.id === id ? x : { ...x, id }));
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6 + 0;
const v3 = (v: THREE.Vector3): [number, number, number] => [r6(v.x), r6(v.y), r6(v.z)];

/** The plane a sketch lands on after a rigid transform. */
export function planeAfter(spec: PlaneSpec, m: THREE.Matrix4): PlaneDef {
  const p = new SketchPlane(spec);
  const rot = new THREE.Matrix3().setFromMatrix4(m);
  return {
    origin: v3(p.origin.clone().applyMatrix4(m)),
    normal: v3(p.n.clone().applyMatrix3(rot).normalize()),
    xdir: v3(p.u.clone().applyMatrix3(rot).normalize()),
  };
}

type Vec3 = [number, number, number];
const movePoint = (p: Vec3, m: THREE.Matrix4): Vec3 => v3(new THREE.Vector3(...p).applyMatrix4(m));

/** Rewrite each sketch's plane, and the world-space profile picks that features
 *  downstream made on it, so an extrude still finds its region. Returns the ids
 *  of sketches that lost a face or datum link. */
export function applySketchMove(
  doc: CadDocument,
  sketchIds: readonly string[],
  resolved: { sketchPlanes?: Record<string, PlaneDef>; datumPlanes?: Record<string, PlaneDef> },
  m: THREE.Matrix4,
): string[] {
  const ids = new Set(sketchIds);
  const detached: string[] = [];
  doc.features = doc.features.map((raw) => {
    const sk = asFeature(raw, "sketch");
    if (sk && ids.has(sk.id)) {
      const { planeId, face, at, ...rest } = sk;
      if (planeId !== undefined || face !== undefined) detached.push(sk.id);
      return { ...rest, plane: planeAfter(planeOf(sk, resolved.sketchPlanes, resolved.datumPlanes), m) } as Feature;
    }
    const f = raw as Feature & {
      sketch?: string;
      regions?: Vec3[];
      region?: Vec3;
      profiles?: { sketch: string; region: Vec3 }[];
    };
    if (f.profiles?.some((p) => ids.has(p.sketch))) {
      return { ...f, profiles: f.profiles.map((p) => (ids.has(p.sketch) ? { ...p, region: movePoint(p.region, m) } : p)) } as Feature;
    }
    if (f.sketch && ids.has(f.sketch) && (f.regions || f.region)) {
      return {
        ...f,
        ...(f.regions ? { regions: f.regions.map((p) => movePoint(p, m)) } : {}),
        ...(f.region ? { region: movePoint(f.region, m) } : {}),
      } as Feature;
    }
    return raw;
  });
  return detached;
}

function boxOfPoints(points: THREE.Vector3[]): THREE.Box3 | null {
  if (!points.length) return null;
  return new THREE.Box3().setFromPoints(points);
}

function entityWorldPoints(
  ents: readonly ResolvedEntity[],
  plane: SketchPlane,
  outline?: (e: ResolvedEntity) => THREE.Vector2[],
): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const e of ents) {
    const drawn = e.type === "text" ? (outline?.(e) ?? []) : [];
    if (drawn.length) for (const p of drawn) out.push(plane.to3D(p.x, p.y));
    else if (e.type === "point" || e.type === "text") out.push(plane.to3D(e.x, e.y));
    else for (const p of entityPolyline(e)) out.push(plane.to3D(p.x, p.y));
  }
  return out;
}

/** The slice of an open sketch the entity gizmo needs. */
export interface SketchGizmoHost {
  plane(): SketchPlane;
  /** the selected entities, projected ones excluded */
  selection(): ResolvedEntity[];
  showPreview(ents: ResolvedEntity[] | null): void;
  /** replace (or, with copy, add beside) each selected entity; one undo step */
  apply(map: (e: ResolvedEntity, id: string) => ResolvedEntity[], copy: boolean): void;
  /** a text's glyph outlines, which its anchor point alone does not describe */
  outline?(e: ResolvedEntity): THREE.Vector2[];
}

export function sketchEntityTarget(host: SketchGizmoHost): MoveTarget | null {
  if (!host.selection().length) return null;
  const plane = host.plane();
  const frame = [plane.u.clone(), plane.v.clone(), plane.n.clone()] as const;
  const points = () => entityWorldPoints(host.selection(), plane, host.outline?.bind(host));
  return {
    frame,
    handles: IN_PLANE_HANDLES,
    uniformScale: true,
    canCopy: true,
    ownsEscape: true,
    centroid: () => boxOfPoints(points())?.getCenter(new THREE.Vector3()) ?? plane.origin.clone(),
    box: () => boxOfPoints(points()),
    begin: () => {},
    preview: (m) => {
      const sim = similarityIn(plane, m);
      host.showPreview(host.selection().flatMap((e) => transformEntity(e, sim, e.id)));
    },
    commit: (r) => {
      host.showPreview(null);
      if (!r.moved && !r.turned && !r.sized) return { id: null, rebuild: false };
      const sim = similarityIn(plane, r.matrix);
      host.apply((e, id) => transformEntity(e, sim, id), r.copy);
      return { id: null, rebuild: false };
    },
    end: () => host.showPreview(null),
    reopen: () => sketchEntityTarget(host),
  };
}

/** Whole sketches, and any bodies selected with them, moved from the model. */
export function sketchFeatureTarget(
  viewport: Viewport,
  store: DocumentStore,
  overlay: SketchOverlay,
  sketchIds: string[],
  bodies: string[],
): MoveTarget | null {
  const sketches = () =>
    sketchIds
      .map((id) => asFeature(store.document.features.find((f) => f.id === id), "sketch"))
      .filter((f): f is NonNullable<typeof f> => !!f);
  if (!sketches().length) return null;
  const points = () => {
    const resolved = overlay.resolvedPlanes();
    const out: THREE.Vector3[] = [];
    for (const sk of sketches()) {
      const plane = new SketchPlane(planeOf(sk, resolved.sketchPlanes, resolved.datumPlanes));
      out.push(...entityWorldPoints(resolveEntities(sk, store.document.parameters), plane));
    }
    const bb = bodies.length ? viewport.bodiesBox(bodies) : null;
    if (bb) out.push(bb.min.clone(), bb.max.clone());
    return out;
  };
  const setOverlay = (m: THREE.Matrix4 | null) => {
    for (const id of sketchIds) overlay.setSketchTransform(id, m);
    viewport.requestRender();
  };
  return {
    frame: WORLD_FRAME,
    // a plane cannot carry a resize
    handles: { ...ALL_HANDLES, cubes: [] },
    uniformScale: false,
    canCopy: false,
    ownsEscape: false,
    centroid: () => boxOfPoints(points())?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3(),
    box: () => boxOfPoints(points()),
    begin: () => {
      if (bodies.length) viewport.beginBodyMoveGhost(bodies);
    },
    preview: (m) => {
      setOverlay(m);
      if (bodies.length) viewport.setBodyMoveTransform(m);
    },
    commit: (r) => {
      if (bodies.length) viewport.endBodyMoveGhost(false);
      if (!r.moved && !r.turned) {
        setOverlay(null);
        return { id: null, rebuild: false };
      }
      const features = bodies.length ? bodyMoveFeatures(store, { ...r, sized: false, copy: false }, bodies) : [];
      const resolved = overlay.resolvedPlanes();
      let detached: string[] = [];
      store.editAndAdd((d) => {
        detached = applySketchMove(d, sketchIds, resolved, r.matrix);
      }, features);
      if (detached.length) toast("Moved off the face or plane it was attached to, the sketch no longer follows it");
      return { id: features[features.length - 1]?.id ?? sketchIds[0] ?? null, rebuild: true };
    },
    end: (restore) => {
      setOverlay(null);
      if (bodies.length) viewport.endBodyMoveGhost(restore);
    },
    reopen: () => sketchFeatureTarget(viewport, store, overlay, sketchIds, bodies),
  };
}
