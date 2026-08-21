// Load-time document migration to the current FORMAT_VERSION. Mutates the parsed
// document in place and returns user-facing warnings. Idempotent, so it can run on
// every load.
//
// v1 -> v2: polygon.angle was RADIANS (the lone outlier) and is now degrees;
//   dimension constraints gain a stable `id`; bare parameter names stored in
//   numeric fields become model parameters with the field rewritten to the cached
//   number (loss-free); plain user parameters get a paramDefs row.
// v2 -> v3: the "projected" sketch entity. Pure ADDITION — the stamp alone marks
//   the format, and older builds skip unknown entity types rather than crashing.
// v3 -> v4: the "offset" sketch constraint and the sketch feature's `planeId` (a
//   by-id datum reference, so an offset plane's distance stays editable instead of
//   being baked into the origin). Also pure additions; `plane` is still written
//   alongside `planeId` as a resolved cache, so older builds still place the sketch.

import type { CadDocument, ParamDef, ParamTarget } from "../types";
import { FEATURE_NUM_FIELDS, RIGID_ENTITY_NUM_FIELDS, kindUnit } from "./numFields";
import { isDimConstraint, newConstraintId, noteConstraintId } from "../sketch/id";
import { nextDName } from "../params/engine";

// v4 → v5: geometry left the document. An `import` feature used to carry the
// whole shape inline as base64 ASCII BREP (`brep`); it now carries `geom`, the
// content hash of the same geometry stored as binary BREP inside the document
// container. On the 356 MiB reference assembly that inline field alone was
// 541.8 MiB — 4.2x over the websocket frame cap and 6.4x over the 64 MiB
// embedded-BREP cap re-checked on every rebuild, which is why an assembly that
// size could not be opened at all.
//
// The stamp alone marks the format: `brep` is still READ, so a v4 document keeps
// rebuilding untouched, and it is rewritten to `geom` when the document is
// migrated on open. The file itself also changes shape (JSON → ZIP), which is
// the first migration that is not purely a data rewrite — older builds get an
// explicit "update Neocad" message rather than a JSON syntax error.

// v5 → v6: `rectangle.angle` (degrees about its own centre), so a rectangle drawn
// from three points can be SAVED as a rectangle rather than decomposed into four
// lines — which would have cost it its W/H dimension, its "<rectId>~k" edge
// addressing and its identity in the browser tree.
//
// A pure addition, and absent still means 0, so no data is rewritten. It is
// stamped anyway because the failure mode without a stamp is worse than the ones
// v3 and v4 guarded against: an older build does not skip a field it does not
// know, it ignores it and draws the rectangle axis-aligned — the wrong SHAPE,
// silently. The stamp turns that into the "made by a newer version" warning.

// v6 -> v7: `datumPlane.face` (and `datumPlane.at` for a round face), the face
// selector that makes a datum plane FOLLOW the face it was made from instead of
// freezing that face's numbers. `plane` is still written as the resolved cache,
// so the datum lands in the right place either way on open.
//
// A pure addition, stamped for the same reason v6 was. An older build does not
// skip the field, it ignores it: the datum silently stops following, so editing
// the part underneath it moves the geometry and leaves the plane, and every
// sketch on that plane with it. Nothing about the file looks wrong. The stamp
// turns that into the "made by a newer version" warning.

// v7 -> v8: `revolve.regions`, plus a change of MEANING that needs no new field.
//
// The meaning first. `extrude.regions` (and `loft.profiles[].region`) is an
// interior point, and it used to select the whole profile it landed in; it now
// selects the AREA of that profile the point is actually in, cut where the model
// under the sketch ends, which is what the overlay has drawn and hit-tested since
// profiles started splitting at the face edge they cross.
//
// `revolve.regions` is the same selection, newly written down. Revolve read the
// picked profile and stored only its sketch, so the builder spun everything on
// that plane. Absent still means the whole sketch, which is what an older file
// meant and what one without a selection still means.
//
// Stamped even though nothing is rewritten, because the two builds disagree about
// geometry rather than about data. An older build opening a v8 file joins or cuts
// with the WHOLE profile where the file means one half of it — a hole that eats
// the part it was drawn on, and nothing in the file looks wrong. The stamp turns
// that into the "made by a newer version" warning.
//
// The change runs the other way too, and cannot be migrated: a pre-v8 file whose
// profile crossed the edge of its face extruded whole, and now extrudes the piece
// under its saved point. Nothing in the file records which was meant — the point
// is all there ever was — so those features open smaller and are re-dragged.

/** Document file-format version (bump when the on-disk shape changes incompatibly). */
export const FORMAT_VERSION = 8;

export function migrateDocument(parsed: CadDocument): string[] {
  const version = parsed.version ?? 1;
  if (version > FORMAT_VERSION) {
    // Best effort: load what we understand, but don't rewrite shapes we don't.
    return [
      "This file was made by a newer version of Neocad, unknown data (e.g. parameter expressions) may be lost if you save it here.",
    ];
  }

  const features = parsed.features ?? [];
  const params = parsed.parameters ?? {};
  const defs: Record<string, ParamDef> = parsed.paramDefs ?? {};

  // --- v1: polygon.angle radians → degrees ---
  if (version < 2) {
    for (const f of features) {
      if (f.type !== "sketch") continue;
      for (const e of f.entities) {
        if (e.type === "polygon" && typeof e.angle === "number") {
          e.angle = (e.angle * 180) / Math.PI;
        }
      }
    }
  }

  // --- stamp dimension-constraint ids (reserve all loaded ones first) ---
  const dims = features.flatMap((f) => (f.type === "sketch" ? (f.constraints ?? []).filter(isDimConstraint) : []));
  for (const c of dims) noteConstraintId(c.id);
  for (const c of dims) c.id ??= newConstraintId();

  // --- seed paramDefs rows for plain user parameters ---
  for (const [name, value] of Object.entries(params)) {
    if (!defs[name]) defs[name] = { expr: String(value), value, unit: "mm" };
  }

  // --- bare-name numeric fields → model parameters (dN) ---
  const bind = (holder: object, field: string, unit: ParamDef["unit"], target: ParamTarget) => {
    const h = holder as Record<string, unknown>;
    const raw = h[field];
    if (typeof raw !== "string") return;
    const value = params[raw];
    if (value === undefined) return; // not a known param — leave for the legacy path
    h[field] = value;
    defs[nextDName(defs)] = { expr: raw, value, unit, target };
  };
  for (const f of features) {
    for (const [field, , kind] of FEATURE_NUM_FIELDS[f.type] ?? []) {
      bind(f, field, kindUnit(kind), { kind: "feature", feature: f.id, field });
    }
    if (f.type !== "sketch") continue;
    for (const e of f.entities) {
      // Only solver-rigid shapes may be owned by a parameter; other entities'
      // bare names stay on the legacy resolveNum/val() path untouched.
      const fields = RIGID_ENTITY_NUM_FIELDS[e.type];
      if (!fields || !e.id) continue;
      for (const [field, kind] of fields) {
        bind(e, field, kindUnit(kind), { kind: "entity", sketch: f.id, entity: e.id, field });
      }
    }
  }

  // keep files clean: don't persist an empty table
  if (Object.keys(defs).length > 0) parsed.paramDefs = defs;
  else delete parsed.paramDefs;

  return [];
}
