// Load-time migration to FORMAT_VERSION, in place, returning user-facing warnings. Idempotent and shape guarded:
// a newer build's file saved here carries this build's stamp (docs/FUNDA-FORMAT.md), so steps may meet new data.
// v1 -> v2: polygon.angle radians to degrees, dimension constraint ids, bare parameter names become model parameters.
// v2 -> v3: "projected" sketch entity. v3 -> v4: "offset" constraint and sketch `planeId` (`plane` kept as a cache).

import { asFeature } from "../types";
import type { CadDocument, ParamDef, ParamTarget } from "../types";
import { FEATURE_NUM_FIELDS, RIGID_ENTITY_NUM_FIELDS, kindUnit, presentCommonFields } from "./numFields";
import { isDimConstraint, newConstraintId, noteConstraintId } from "../sketch/id";
import { nextDName, sameTarget } from "../params/engine";

// v4 -> v5: import `brep` (inline base64, 541.8 MiB on the reference assembly, 4.2x the websocket frame cap, 6.4x the
// 64 MiB embedded BREP cap checked on every rebuild) becomes `geom`, a hash of binary BREP in the ZIP container. `brep`
// is still read; older builds get an explicit "update FundaCAD" message.

// v5 -> v6: `rectangle.angle`, absent meaning 0. Stamped because an older build would silently draw it axis-aligned.

// v6 -> v7: `datumPlane.face`/`at`, so a datum follows its face; `plane` stays the cache. Stamped because an older
// build would silently stop following.

// v7 -> v8: extrude/loft region points select the area under the point, cut where the model ends, not the whole
// profile; `revolve.regions` and `revolve.axisEdge` (`axis` may be an {origin, dir} line). Stamped because older builds
// disagree about geometry. Pre-v8 profiles crossing a face edge open smaller and must be re-dragged. An absent
// `revolve.regions` still means the whole sketch; an older build reads an {origin, dir} `axis` as Z, silently.

// v8 -> v9: `combine` becomes `boolean`, operation union/subtract/intersect, `keepTools` becomes `keepOriginals`.
// Loss-free, since no v8 document can carry a `boolean` to collide with; an older build raises on the unknown type,
// better than leaving tool bodies inside the part.

// v9 -> v10: `datumPlane.through`, `datumPoint.at`, `datumAxis.through` references, numbers kept as cache.
// Stamped as v7.

// Bump when the on-disk shape changes incompatibly.
export const FORMAT_VERSION = 10;

export function migrateDocument(parsed: CadDocument): string[] {
  const version = parsed.version ?? 1;
  // A newer file's unknown content is kept (store.ts) and reported by openNotice.ts.
  if (version > FORMAT_VERSION) return [];

  const features = parsed.features ?? [];
  const params = parsed.parameters ?? {};
  const defs: Record<string, ParamDef> = parsed.paramDefs ?? {};

  // Positional, so it runs before anything that reads a feature's type.
  if (version < 9) {
    const OPS: Record<string, string> = { join: "union", cut: "subtract", intersect: "intersect" };
    for (const f of features) {
      const raw = f as unknown as Record<string, unknown>;
      if (raw["type"] !== "combine") continue;
      raw["type"] = "boolean";
      raw["operation"] = OPS[String(raw["operation"])] ?? "union";
      if (raw["keepTools"] !== undefined) {
        // Omit-when-false, like the writers: a switch left off is an absent field.
        if (raw["keepTools"]) raw["keepOriginals"] = true;
        delete raw["keepTools"];
      }
    }
  }

  if (version < 2) {
    for (const raw of features) {
      const f = asFeature(raw, "sketch");
      if (!f) continue;
      for (const e of f.entities) {
        if (e.type === "polygon" && typeof e.angle === "number") {
          e.angle = (e.angle * 180) / Math.PI;
        }
      }
    }
  }

  // Reserve all loaded ids first.
  const dims = features.flatMap((f) => asFeature(f, "sketch")?.constraints?.filter(isDimConstraint) ?? []);
  for (const c of dims) noteConstraintId(c.id);
  for (const c of dims) c.id ??= newConstraintId();

  for (const [name, value] of Object.entries(params)) {
    if (!defs[name]) defs[name] = { expr: String(value), value, unit: "mm" };
  }

  const bind = (holder: object, field: string, unit: ParamDef["unit"], target: ParamTarget) => {
    const h = holder as Record<string, unknown>;
    const raw = h[field];
    if (typeof raw !== "string") return;
    const value = params[raw];
    // Not a known param, left for the legacy path.
    if (value === undefined) return;
    h[field] = value;
    // recompute writes targets in table order, so a second def for a bound field would override the one the panel edits
    const existing = Object.values(defs).find((d) => d.target && sameTarget(d.target, target));
    if (existing) {
      existing.expr = raw;
      existing.value = value;
    } else {
      defs[nextDName(defs)] = { expr: raw, value, unit, target };
    }
  };
  for (const f of features) {
    const rows = [
      ...(FEATURE_NUM_FIELDS[f.type] ?? []),
      ...presentCommonFields(f as unknown as Record<string, unknown>),
    ];
    for (const [field, , kind] of rows) {
      bind(f, field, kindUnit(kind), { kind: "feature", feature: f.id, field });
    }
    const sketch = asFeature(f, "sketch");
    if (!sketch) continue;
    for (const e of sketch.entities) {
      // Only solver-rigid shapes may be owned by a parameter; other entities'
      // bare names stay on the legacy resolveNum/val() path untouched.
      const fields = RIGID_ENTITY_NUM_FIELDS[e.type];
      if (!fields || !e.id) continue;
      for (const [field, kind] of fields) {
        bind(e, field, kindUnit(kind), { kind: "entity", sketch: f.id, entity: e.id, field });
      }
    }
  }

  if (Object.keys(defs).length > 0) parsed.paramDefs = defs;
  else delete parsed.paramDefs;

  return [];
}
