// Does the scene contain exactly the model, and nothing else?
//
// The viewport's model group is bookkept by hand: setModel adds a mesh and its
// edges for every body it builds, removes the pair for every body that went
// away, and the progressive stream adds and removes its own while a reply is
// arriving. Every one of those paths is correct in isolation. What no path can
// check is the RESULT, and the result is the thing that goes wrong: an object
// nobody removed stays in the scene, drawn every frame, referenced by nothing.
//
// That failure has a very specific look, which is why it took so long to name.
// A leaked body is not a missing body and not a garbled one: it is the same
// body, one rebuild out of date, sitting a hair away from its replacement. Two
// surfaces that close z-fight across their whole area, so the part draws
// shredded and speckled, every edge doubles, and every hole appears twice. It
// reads as a tessellation bug, or a driver bug, or a corrupt mesh, and it is
// none of those. It is arithmetic: the group holds more than the model does.
//
// So this counts. It is O(children) with no geometry touched, which on the
// heaviest assembly in the test corpus is a few thousand set operations, and it
// runs on every commit because an intermittent fault that is only looked for
// when suspected is a fault that is never caught.
//
// Both directions matter, and they are different bugs:
//
//   EXTRA    an object in the group the model does not account for. The doubled
//            geometry above.
//   MISSING  an object the model claims that is not in the group. The body that
//            is selectable and measurable and simply cannot be seen, which has
//            happened here before, when a stream released buffers it was about
//            to hand on.

import type { Object3D } from "three";
import type { BodyMesh, ModelView } from "../viewport/render";

/** What the viewport legitimately parks in the model group besides the bodies.
 *  Passed in rather than guessed: an audit that quietly tolerated an unknown
 *  object would tolerate the leak it exists to find. */
export interface SceneExtras {
  /** model.orphanEdges' drawable, when there is one. */
  orphanEdges?: Object3D | null | undefined;
  /** the curvature combs overlay, when it is switched on. */
  combs?: Object3D | null | undefined;
}

/** Name an object well enough to act on. A body's mesh carries its BodyMesh in
 *  `userData.owner` (buildBodyMesh sets it so face picking can get back to the
 *  body), which turns "an extra object" into "body <id>, etag <etag>", i.e.
 *  into something that can be matched against the rebuild that produced it. */
function describe(o: Object3D): string {
  const owner = o.userData?.owner as BodyMesh | undefined;
  if (owner?.id) return `body ${owner.id} etag=${owner.etag ?? "none"}`;
  if (o.name) return `${o.type} "${o.name}"`;
  return o.type;
}

export interface SceneAuditResult {
  /** Objects in the group that the model does not account for. */
  extra: string[];
  /** Objects the model claims that are not in the group. */
  missing: string[];
  /** Body ids the model lists more than once. */
  duplicateIds: string[];
  /** Counts, reported even when clean, so a report says how big the model was. */
  children: number;
  bodies: number;
}

export function auditScene(
  children: readonly Object3D[],
  model: ModelView | null,
  extras: SceneExtras = {},
): SceneAuditResult {
  const expected = new Map<Object3D, string>();
  const duplicateIds: string[] = [];
  const seen = new Set<string>();

  for (const b of model?.bodies ?? []) {
    if (seen.has(b.id)) duplicateIds.push(b.id);
    seen.add(b.id);
    expected.set(b.mesh, `body ${b.id} mesh`);
    expected.set(b.edges.object, `body ${b.id} edges`);
  }
  if (model?.orphanEdges) expected.set(model.orphanEdges.object, "orphan edges");
  if (extras.orphanEdges) expected.set(extras.orphanEdges, "orphan edges");
  if (extras.combs) expected.set(extras.combs, "curvature combs");

  const present = new Set<Object3D>(children);
  const extra: string[] = [];
  for (const o of children) if (!expected.has(o)) extra.push(describe(o));
  const missing: string[] = [];
  for (const [o, label] of expected) if (!present.has(o)) missing.push(label);

  return {
    extra,
    missing,
    duplicateIds,
    children: children.length,
    bodies: model?.bodies.length ?? 0,
  };
}

export function auditIsClean(a: SceneAuditResult): boolean {
  return !a.extra.length && !a.missing.length && !a.duplicateIds.length;
}

/** One line, for the pipeline log. Extras are listed by name (capped, because a
 *  leak that fires once tends to fire for every body of the model and the
 *  report has to stay readable), counts otherwise. */
export function auditLine(a: SceneAuditResult): string {
  if (auditIsClean(a)) return `scene clean: ${a.bodies} bodies, ${a.children} objects`;
  const parts: string[] = [];
  if (a.extra.length) parts.push(`${a.extra.length} EXTRA [${a.extra.slice(0, 4).join("; ")}${a.extra.length > 4 ? "; ..." : ""}]`);
  if (a.missing.length) parts.push(`${a.missing.length} MISSING [${a.missing.slice(0, 4).join("; ")}${a.missing.length > 4 ? "; ..." : ""}]`);
  if (a.duplicateIds.length) parts.push(`duplicate body ids [${a.duplicateIds.slice(0, 4).join("; ")}]`);
  return `scene MISMATCH: ${a.bodies} bodies, ${a.children} objects, ${parts.join(", ")}`;
}
