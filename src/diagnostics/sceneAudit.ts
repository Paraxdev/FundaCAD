// Checks the scene group holds exactly the model. A body nobody removed z-fights its replacement a hair away
// (shredded faces, doubled edges, holes twice); it is O(children) with no geometry, so it runs on every commit.

import type { Object3D } from "three";
import type { BodyMesh, ModelView } from "../viewport/render";

// Passed in, not guessed: an audit that tolerated an unknown object would tolerate the leak it exists to find.
export interface SceneExtras {
  orphanEdges?: Object3D | null | undefined;
  combs?: Object3D | null | undefined;
}

// buildBodyMesh puts the BodyMesh in userData.owner, which turns an extra object into a body id and etag.
function describe(o: Object3D): string {
  const owner = o.userData?.owner as BodyMesh | undefined;
  if (owner?.id) return `body ${owner.id} etag=${owner.etag ?? "none"}`;
  if (o.name) return `${o.type} "${o.name}"`;
  return o.type;
}

export interface SceneAuditResult {
  // EXTRA is the leaked, doubled geometry. MISSING is a body that is selectable and measurable but unseen, which
  // happened when a stream released buffers it was about to hand on.
  extra: string[];
  missing: string[];
  duplicateIds: string[];
  // Counts are reported even when clean, so a report says how big the model was.
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

// Extras are capped: a leak that fires once tends to fire for every body, and the report has to stay readable.
export function auditLine(a: SceneAuditResult): string {
  if (auditIsClean(a)) return `scene clean: ${a.bodies} bodies, ${a.children} objects`;
  const parts: string[] = [];
  if (a.extra.length)
    parts.push(`${a.extra.length} EXTRA [${a.extra.slice(0, 4).join("; ")}${a.extra.length > 4 ? "; ..." : ""}]`);
  if (a.missing.length)
    parts.push(
      `${a.missing.length} MISSING [${a.missing.slice(0, 4).join("; ")}${a.missing.length > 4 ? "; ..." : ""}]`,
    );
  if (a.duplicateIds.length) parts.push(`duplicate body ids [${a.duplicateIds.slice(0, 4).join("; ")}]`);
  return `scene MISMATCH: ${a.bodies} bodies, ${a.children} objects, ${parts.join(", ")}`;
}
