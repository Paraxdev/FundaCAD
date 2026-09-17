// Putting a fastener into the model the way an imported STEP part arrives: the solid is generated
// once and stored as an `import` feature's blob, so the document never needs this plugin to build.

import { toast, type Engine, type ShapePlacement } from "fundacad";
import type { FastenerSpec } from "./spec";
import { GENERATOR, PLUGIN_ID } from "./state";

type Vec = { x: number; y: number; z: number };

function placementFrom(origin: Vec, normal: Vec): ShapePlacement {
  return { origin: [origin.x, origin.y, origin.z], zAxis: [normal.x, normal.y, normal.z] };
}

/** On the one selected flat face, at its centre, pointing out of it. Null for anything else. */
export function placementFromSelection(e: Engine): ShapePlacement | null {
  const picked = e.viewport.selectedFacesForPressPull?.();
  if (!picked || picked.faceIds.length !== 1) return null;
  const plane = e.viewport.planarFace(picked.faceIds[0]!);
  if (!plane) return null;
  return placementFrom(picked.anchor, plane.normal);
}

/** Where a drop at a screen point lands: on the flat face under it, where the pointer struck it,
 *  or on the corner, edge middle or face centre it snaps to when that lies on the same face. */
export function placementAt(e: Engine, clientX: number, clientY: number): ShapePlacement | null {
  const hit = e.viewport.pickFaceForPressPull(clientX, clientY);
  if (!hit) return null;
  const plane = e.viewport.planarFace(hit.faceId);
  if (!plane) return null;
  // pointAt snaps to edges of every body, hidden ones included, so a snap off this face is ignored.
  const snapped = e.viewport.pointAt(clientX, clientY)?.p;
  const onFace = snapped && Math.abs(plane.normal.dot(snapped) - plane.normal.dot(plane.origin)) < 1e-4;
  return placementFrom(onFace ? snapped : hit.anchor, plane.normal);
}

/** The feature id the fastener became, or null when it could not be made (and the person was told). */
export async function insertFastener(e: Engine, spec: FastenerSpec, placement: ShapePlacement | null): Promise<string | null> {
  const generate = e.geometry.generateShape?.bind(e.geometry);
  if (!generate) {
    toast("Fasteners need the geometry engine, which this build does not run", { kind: "error" });
    return null;
  }
  e.setStatus(`Inserting ${spec.name}`, "");
  const reply = await generate(GENERATOR, spec, { output: "store", ...(placement ? { placement } : {}) });
  if (!reply.ok || !reply.shape.geom) {
    const why = reply.ok ? "no geometry came back" : reply.message;
    e.setStatus(`Could not insert ${spec.name}`, "");
    toast(`Could not insert ${spec.name}: ${why}`, { kind: "error" });
    return null;
  }
  const id = e.store.nextId();
  e.store.addFeature({
    id,
    type: "import",
    format: "brep",
    name: spec.name,
    geom: reply.shape.geom,
    solid: reply.shape.solid,
    generatedBy: { plugin: PLUGIN_ID, spec: spec as unknown as Record<string, unknown> },
  });
  e.setStatus(`Inserted ${spec.name}`, "");
  e.noteCommitted(id);
  e.selectFeature(id);
  return id;
}

/** The spec a body was generated from by this plugin, when it was. */
export function specOfBody(e: Engine, bodyId: string): FastenerSpec | null {
  const body = e.store.buildState.result?.bodies?.find((b) => b.id === bodyId);
  if (!body?.faceOwners?.length) return null;
  for (const owner of new Set(body.faceOwners)) {
    const f = e.store.document.features.find((x) => x.id === owner) as
      | { type?: string; generatedBy?: { plugin?: string; spec?: unknown } }
      | undefined;
    if (f?.type === "import" && f.generatedBy?.plugin === PLUGIN_ID && f.generatedBy.spec) {
      return f.generatedBy.spec as FastenerSpec;
    }
  }
  return null;
}
