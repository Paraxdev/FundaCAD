// What the move gizmo acts on. The gizmo owns the handles, the stepping and the
// pivot; a target owns where the selection is, how it previews, and what a
// finished drag writes.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature } from "../types";
import type { MoveValues } from "./transformGizmo";

export type Frame = readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3];

export const WORLD_FRAME: Frame = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];

/** Which handles to build, by frame axis index. A plane handle and a ring are
 *  indexed by their normal. */
export interface MoveHandleSet {
  axes: readonly number[];
  rings: readonly number[];
  planes: readonly number[];
  cubes: readonly number[];
}

export const ALL_HANDLES: MoveHandleSet = { axes: [0, 1, 2], rings: [0, 1, 2], planes: [0, 1, 2], cubes: [0, 1, 2] };

/** Handles that keep a selection inside the plane spanned by frame axes 0 and 1. */
export const IN_PLANE_HANDLES: MoveHandleSet = { axes: [0, 1], rings: [2], planes: [2], cubes: [0, 1] };

export interface MoveResult {
  values: MoveValues;
  /** per world axis resize about `pivot`, 1 meaning untouched */
  scale: THREE.Vector3;
  pivot: THREE.Vector3;
  /** the whole transform, resize first */
  matrix: THREE.Matrix4;
  moved: boolean;
  turned: boolean;
  sized: boolean;
  copy: boolean;
}

export interface MoveCommit {
  /** the feature to report as committed, if any */
  id: string | null;
  /** a rebuild has to land before the target can be reopened */
  rebuild: boolean;
}

export interface MoveTarget {
  readonly frame: Frame;
  readonly handles: MoveHandleSet;
  /** every resize handle drives one factor for all axes */
  readonly uniformScale: boolean;
  readonly canCopy: boolean;
  /** Escape stops at the gizmo instead of also reaching the mode underneath */
  readonly ownsEscape: boolean;
  centroid(): THREE.Vector3;
  /** world box of the selection, what rotate and resize steps measure against */
  box(): THREE.Box3 | null;
  begin(): void;
  preview(matrix: THREE.Matrix4, copy: boolean): void;
  commit(r: MoveResult): MoveCommit;
  /** idempotent; `restore` puts the untouched pose back */
  end(restore: boolean): void;
  /** the same selection again, for the next drag */
  reopen(): MoveTarget | null;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function moveFeature(id: string, v: MoveValues, bodies: string[], copy = false): Feature {
  return {
    id,
    type: copy ? "duplicate" : "move",
    dx: r3(v.dx),
    dy: r3(v.dy),
    dz: r3(v.dz),
    rx: r3(v.rx),
    ry: r3(v.ry),
    rz: r3(v.rz),
    ...(bodies.length ? { bodies } : {}),
  } as Feature;
}

export function scaleFeature(id: string, s: THREE.Vector3, about: THREE.Vector3, bodies: string[]): Feature {
  return {
    id,
    type: "scale",
    factor: 1,
    sx: r6(s.x),
    sy: r6(s.y),
    sz: r6(s.z),
    about: [r6(about.x), r6(about.y), r6(about.z)],
    ...(bodies.length ? { bodies } : {}),
  };
}

/** The features a body move writes, resize first because that is the order
 *  the preview composed them in. A copy cannot carry a resize: `duplicate` has
 *  no scale and a `scale` would resize the originals. */
export function bodyMoveFeatures(store: DocumentStore, r: MoveResult, bodies: string[]): Feature[] {
  const ids = freshIds(store, 2);
  const out: Feature[] = [];
  if (r.sized && !r.copy) out.push(scaleFeature(ids[0]!, r.scale, r.pivot, bodies));
  if (r.moved || r.turned) out.push(moveFeature(ids[1]!, r.values, bodies, r.copy));
  return out;
}

/** Note: store.nextId() only looks at features already in the document, so two
 *  calls before adding anything return the same id. */
export function freshIds(store: DocumentStore, n: number): string[] {
  const taken = new Set(store.document.features.map((f) => f.id));
  const out: string[] = [];
  for (let i = 1; out.length < n; i++) {
    const id = `f${taken.size + i}`;
    if (!taken.has(id)) out.push(id);
  }
  return out;
}

export function bodyMoveTarget(viewport: Viewport, store: DocumentStore, bodies: string[]): MoveTarget {
  return {
    frame: WORLD_FRAME,
    handles: ALL_HANDLES,
    uniformScale: false,
    canCopy: true,
    ownsEscape: false,
    centroid: () => viewport.bodiesCentroid(bodies),
    box: () => viewport.bodiesBox(bodies),
    begin: () => viewport.beginBodyMoveGhost(bodies),
    preview: (m) => viewport.setBodyMoveTransform(m),
    commit: (r) => {
      viewport.endBodyMoveGhost(r.copy); // a copy leaves the originals where they were
      const features = bodyMoveFeatures(store, r, bodies);
      store.addFeatures(features);
      return { id: features[features.length - 1]?.id ?? null, rebuild: features.length > 0 };
    },
    end: (restore) => viewport.endBodyMoveGhost(restore),
    reopen: () => bodyMoveTarget(viewport, store, bodies),
  };
}
