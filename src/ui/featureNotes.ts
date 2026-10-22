// Resolves a build's overlapping featureErrors and diagnostics to at most one note per timeline chip. An error always
// wins. Any advisory with a reason lights the chip, not a list of codes, so a new engine advisory shows at once.

import { featureTypeOwner } from "../document/missingPlugins";

/** Structural, so a test or a cached partial build need not construct a whole RebuildResult. */
export interface NoteSources {
  featureErrors?: { feature_id?: string }[] | undefined;
  /** The legacy single error field. Null is accepted since the build state holds null between builds. */
  errorFeatureId?: string | null | undefined;
  diagnostics?: { feature_id?: string; reason?: string }[] | undefined;
}

/** One advisory per feature. Failed features are absent, as is a diagnostic with no `reason`; the first reason wins. */
export function featureNotes(src: NoteSources): Map<string, string> {
  const failed = new Set<string>();
  for (const e of src.featureErrors ?? []) if (e.feature_id) failed.add(e.feature_id);
  if (src.errorFeatureId) failed.add(src.errorFeatureId);

  const notes = new Map<string, string>();
  for (const d of src.diagnostics ?? []) {
    const id = d.feature_id;
    if (!id || !d.reason || failed.has(id) || notes.has(id)) continue;
    notes.set(id, d.reason);
  }
  return notes;
}

export interface FailureSources {
  featureErrors?: { feature_id?: string; message: string }[] | undefined;
  errorFeatureId?: string | null | undefined;
  errorMessage?: string | null | undefined;
  heldRefusal?: { featureId: string } | null | undefined;
}

/** For the History badge and red chips. A held preview's refusal is left out: its tool explains it in the value box. */
export function featureFailures(src: FailureSources): Map<string, string> {
  const failed = new Map<string, string>();
  for (const e of src.featureErrors ?? []) if (e.feature_id) failed.set(e.feature_id, e.message);
  const id = src.errorFeatureId;
  if (id && !failed.has(id) && src.heldRefusal?.featureId !== id) failed.set(id, src.errorMessage ?? "failed");
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
  if (owner)
    return `Not included: it needs the "${owner.name}" plugin, which is not running here. It is kept and saved with the file.`;
  return "Not included: this version of FundaCAD does not know this feature type. It is kept and saved with the file. A newer FundaCAD or a plugin can build it.";
}
