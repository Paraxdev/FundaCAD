// Which features built but had something to say, and which simply failed.
//
// A build hands back two lists that overlap: `featureErrors` names what went
// wrong, and `diagnostics` carries everything the sidecar noticed on the way,
// including entries for features that then failed for a different reason. The
// timeline has one chip per feature and one tooltip per chip, so those two have
// to resolve to at most one thing to say about each.
//
// Pure and here rather than inline in the chip builder, because the RULE is the
// interesting part and a component test can only see that a chip is amber. The
// rule is: an error wins, always. A feature that failed is red and its own
// message is the useful one; an advisory about a cut that was then thrown away
// is noise stacked on top of a failure.
//
// Kept generic rather than keyed to a list of codes. The sidecar only records
// diagnostics worth acting on, so every advisory it learns to emit should light
// the chip the day it lands rather than the day someone remembers to extend a
// list here.

/** The subset of a build result this reads. Structural, not the real types, so
 *  a caller can pass a partial build (a test, a resumed cache hit) without
 *  constructing a whole RebuildResult. */
export interface NoteSources {
  featureErrors?: { feature_id?: string }[] | undefined;
  /** The single legacy error field, for a build that reported one that way.
   *  Null as well as undefined, that is what the build state holds between
   *  builds and a caller should not have to launder it. */
  errorFeatureId?: string | null | undefined;
  diagnostics?: { feature_id?: string; reason?: string }[] | undefined;
}

/** feature id -> the one advisory to show for it.
 *
 *  Features that FAILED are absent: their error is what the chip says. A
 *  diagnostic with no `reason` is absent too, there is nothing to put in a
 *  tooltip, and a chip that turned amber with an empty explanation would be
 *  worse than one that stayed quiet.
 *
 *  First reason wins per feature. The chip is 28px and this is its tooltip. */
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
