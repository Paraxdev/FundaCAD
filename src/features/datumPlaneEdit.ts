// Editing a datum plane's pose after the fact, by either of the two handles:
// its own arcs (DatumPoseTool) or the Move gizmo. Both write the same relative
// fields, never a baked plane, so the datum keeps following its reference and a
// parameter bound to a field keeps driving it.

import * as THREE from "three";
import type { DocumentStore } from "../document/store";
import { asFeature, type Feature, type PlaneSpec } from "../types";
import { FEATURE_NUM_FIELDS } from "../document/numFields";
import {
  placeDatum,
  poseFromPlaced,
  poseOf,
  POSE_FIELDS,
  type DatumPose,
  type PoseField,
} from "../document/datumPose";
import type { DatumPoseTool } from "./datumPoseTool";
import type { MoveTarget } from "./moveTarget";
import { toast } from "../ui/toast";

type Datum = Extract<Feature, { type: "datumPlane" }>;

export interface DatumEditDeps {
  store: DocumentStore;
  sourceOf(f: Datum): PlaneSpec;
  previewPose(id: string, pose: DatumPose | null): void;
}

function datum(store: DocumentStore, id: string): Datum | null {
  return asFeature(store.document.features.find((f) => f.id === id), "datumPlane") ?? null;
}

/** Fields an expression drives: a handle must not write them, the parameter would
 *  put them straight back. */
export function lockedPoseFields(store: DocumentStore, id: string): Set<PoseField> {
  return new Set(POSE_FIELDS.filter((field) => store.isParamBound({ kind: "feature", feature: id, field })));
}

const kindOf = (field: PoseField) =>
  FEATURE_NUM_FIELDS.datumPlane?.find(([f]) => f === field)?.[2] ?? "length";

/** Write the fields that changed. A field bound to a plain parameter updates that
 *  parameter, so the binding survives the drag. */
export function writeDatumPose(
  store: DocumentStore,
  id: string,
  pose: DatumPose,
): { written: boolean; refused: PoseField[] } {
  const f = datum(store, id);
  if (!f) return { written: false, refused: [] };
  let written = false;
  const before = poseOf(f);
  const locked = lockedPoseFields(store, id);
  const patch: Partial<Record<PoseField, number | undefined>> = {};
  const refused: PoseField[] = [];
  for (const field of POSE_FIELDS) {
    const v = pose[field];
    if (Math.abs(v - before[field]) < 1e-9) continue;
    if (locked.has(field)) {
      refused.push(field);
      continue;
    }
    const target = { kind: "feature" as const, feature: id, field };
    written = true;
    if (store.boundExpr(target)) store.setTargetValue(target, v, kindOf(field));
    else patch[field] = v === 0 && field !== "offset" ? undefined : v;
  }
  if (Object.keys(patch).length) store.updateFeature(id, patch as Partial<Feature>);
  return { written, refused };
}

/** The preview a drag shows downstream: the datum rebuilt in place, so the
 *  sketches and bodies placed on it move with the hand. */
function livePreview(store: DocumentStore, id: string) {
  let open = false;
  return {
    show(pose: DatumPose) {
      const f = datum(store, id);
      if (!f) return;
      const next = { ...f, ...pose } as Feature;
      if (open) store.setEditPreview(next);
      else {
        open = true;
        store.beginEditPreview(id, next, { inPlace: true });
      }
    },
    end(rebuild: boolean) {
      if (open) store.endEditPreview(rebuild);
      open = false;
    },
  };
}

/** Open the datum's own arcs on it. False when there is nothing to drag, every
 *  field an expression drives. */
export function startDatumPoseEdit(
  deps: DatumEditDeps & { tool: DatumPoseTool },
  id: string,
  done: (id: string | null) => void,
): boolean {
  const f = datum(deps.store, id);
  if (!f || deps.tool.active) return false;
  const locked = lockedPoseFields(deps.store, id);
  if (["offset", "tiltX", "tiltY", "spin"].every((k) => locked.has(k as PoseField))) return false;
  const preview = livePreview(deps.store, id);
  deps.tool.start(
    {
      src: deps.sourceOf(f),
      pose: poseOf(f),
      ghost: false,
      locked,
      onLive: (pose) => {
        deps.previewPose(id, pose);
        preview.show(pose);
      },
      onStep: (pose) => void writeDatumPose(deps.store, id, pose),
    },
    () => {
      preview.end(true);
      deps.previewPose(id, null);
      done(id);
    },
  );
  return true;
}

const QUAD_HALF = 40;

/** The Move gizmo on a datum plane: its arrows and rings sit on the plane's own
 *  axes, and a finished drag is read back into the pose relative to the
 *  reference rather than written as a new absolute plane. */
export function datumMoveTarget(deps: DatumEditDeps, id: string): MoveTarget | null {
  const f = datum(deps.store, id);
  if (!f) return null;
  const src = deps.sourceOf(f);
  const pose = poseOf(f);
  const def = placeDatum(src, pose);
  const origin = new THREE.Vector3(...def.origin);
  const n = new THREE.Vector3(...def.normal).normalize();
  const u = new THREE.Vector3(...def.xdir).normalize();
  const v = n.clone().cross(u);
  const preview = livePreview(deps.store, id);
  // Unrounded, unlike a sketch's planeAfter: the pose is read back out of this and
  // a millionth of a millimetre there is a 44.99999 degree tilt here.
  const poseAfter = (m: THREE.Matrix4) => {
    const rot = new THREE.Matrix3().setFromMatrix4(m);
    const o = origin.clone().applyMatrix4(m);
    const nn = n.clone().applyMatrix3(rot).normalize();
    const uu = u.clone().applyMatrix3(rot).normalize();
    return poseFromPlaced(src, { origin: [o.x, o.y, o.z], normal: [nn.x, nn.y, nn.z], xdir: [uu.x, uu.y, uu.z] });
  };
  return {
    frame: [u, v, n],
    handles: { axes: [0, 1, 2], rings: [0, 1, 2], planes: [0, 1, 2], cubes: [] },
    uniformScale: false,
    canCopy: false,
    ownsEscape: false,
    centroid: () => origin.clone(),
    box: () => {
      const corners = [-1, 1].flatMap((a) => [-1, 1].map((b) =>
        origin.clone().addScaledVector(u, a * QUAD_HALF).addScaledVector(v, b * QUAD_HALF)));
      return new THREE.Box3().setFromPoints(corners);
    },
    begin: () => {},
    preview: (m) => {
      const p = poseAfter(m);
      deps.previewPose(id, p);
      preview.show(p);
    },
    commit: (r) => {
      preview.end(false);
      deps.previewPose(id, null);
      if (!r.moved && !r.turned) return { id: null, rebuild: false };
      const { written, refused } = writeDatumPose(deps.store, id, poseAfter(r.matrix));
      if (refused.length) toast(`${refused.join(", ")} ${refused.length > 1 ? "are" : "is"} driven by an expression and was left as it is`);
      return { id, rebuild: written };
    },
    end: (restore) => {
      preview.end(restore);
      deps.previewPose(id, null);
    },
    reopen: () => datumMoveTarget(deps, id),
  };
}
