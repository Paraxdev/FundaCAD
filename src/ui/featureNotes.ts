// Resolves a build's overlapping featureErrors and diagnostics to at most one note per timeline chip. An error always
// wins. Any advisory with a reason lights the chip, not a list of codes, so a new engine advisory shows at once.

import { featureTypeOwner } from "../document/missingPlugins";
import { blendFitsArgs } from "../features/edgeDragMath";
import { t } from "../i18n";
import { shownLine } from "./englishLines";

/** Structural, so a test or a cached partial build need not construct a whole RebuildResult. */
export interface NoteSources {
  featureErrors?: { feature_id?: string }[] | undefined;
  /** The legacy single error field. Null is accepted since the build state holds null between builds. */
  errorFeatureId?: string | null | undefined;
  diagnostics?: { feature_id?: string; reason?: string; code?: string; lossy?: boolean }[] | undefined;
}

/** One advisory per feature. Failed features are absent, as is a diagnostic with no `reason`. The first reason wins,
 *  except that a coded advisory replaces a lossy match's note, since it says what the feature built. */
export function featureNotes(src: NoteSources): Map<string, string> {
  const failed = new Set<string>();
  for (const e of src.featureErrors ?? []) if (e.feature_id) failed.add(e.feature_id);
  if (src.errorFeatureId) failed.add(src.errorFeatureId);

  const notes = new Map<string, string>();
  const fromLossy = new Set<string>();
  for (const d of src.diagnostics ?? []) {
    const id = d.feature_id;
    if (!id || !d.reason || failed.has(id)) continue;
    if (notes.has(id) && !(d.code && fromLossy.has(id))) continue;
    notes.set(id, advisoryNote(d.code, d.reason));
    if (d.lossy && !d.code) fromLossy.add(id);
    else fromLossy.delete(id);
  }
  return notes;
}

// The advisories the app words itself, so their note follows the chosen language. Any other shows the engine's reason.
function advisoryNote(code: string | undefined, reason: string): string {
  if (code === "blendOverrun") {
    const kind = /mm the chamfer runs past/i.test(reason) ? "chamfer" : "fillet";
    return t("feature.note.blendOverrun", { kind, ...blendFitsArgs(reason) });
  }
  return reason;
}

export interface FailureSources {
  featureErrors?: { feature_id?: string; message: string }[] | undefined;
  errorFeatureId?: string | null | undefined;
  errorMessage?: string | null | undefined;
  heldRefusal?: { featureId: string } | null | undefined;
}

/** For the History badge and red chips, each message as shown. A held preview's refusal is left out: its tool explains
 *  it in the value box. */
export function featureFailures(src: FailureSources): Map<string, string> {
  const failed = new Map<string, string>();
  for (const e of src.featureErrors ?? []) if (e.feature_id) failed.set(e.feature_id, shownLine(e.message));
  const id = src.errorFeatureId;
  if (id && !failed.has(id) && src.heldRefusal?.featureId !== id)
    failed.set(id, src.errorMessage ? shownLine(src.errorMessage) : "failed");
  return failed;
}

export interface PlaceholderSources {
  skippedFeatures?: { feature_id: string; type: string }[] | undefined;
}

/** feature id -> type, for the features the last build left out because this
 *  version does not know their type. They are greyed in History, never red. */
export function featurePlaceholders(src: PlaceholderSources): Map<string, string> {
  return new Map((src.skippedFeatures ?? []).map((s) => [s.feature_id, s.type]));
}

/** What a placeholder chip and its properties say about a feature of `type`. */
export function placeholderNote(type: string): string {
  const owner = featureTypeOwner(type);
  return owner ? t("feature.note.needsPlugin", { plugin: owner.name }) : t("feature.note.unknownType");
}
