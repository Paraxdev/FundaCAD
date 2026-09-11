// Which features in this document need a plugin that is not here.
//
// THE TRADE THIS PAYS FOR. A plugin that genuinely owns a feature type owns the
// geometry too, so a document holding one of its features cannot be built on a
// machine where the plugin is absent. That is the honest cost of a real plugin
// boundary, and the alternative, keeping the geometry in the application so
// every file always builds, is what made the texture tool a panel in front of
// code that shipped either way.
//
// What the cost must never become is a mystery. So the file OPENS, every value
// is kept, nothing is dropped on the next save, and the person is told exactly
// which plugin to install, by name, once, at the top of the document rather than
// as a red chip per feature they have to click through.
//
// WHAT THIS IS NOT. It is not a permission check and not a validation pass. A
// feature type nobody claims is reported too ("an unknown feature"), because
// from the reader's side a plugin that was never installed and a plugin that no
// longer exists are the same situation and deserve the same sentence.
//
// The sidecar answers the same question independently, from the manifests it
// finds on disk (see plugin_geometry.unregistered), and its answer is what turns
// the feature's own timeline row red. This is the document-level summary: what
// is missing, and what it costs.

import { contributedFeatureTypes } from "../plugins/contrib";
import { shippedPlugins } from "../plugins/shipped";
import type { CadDocument, Feature } from "../types";
import { FEATURE_NUM_FIELDS } from "./numFields";

/** One plugin a document needs and does not have. */
export interface MissingPlugin {
  /** The plugin id from the manifest, or null when nothing claims the type. */
  id: string | null;
  /** Its display name, or the feature type itself when nothing claims it. */
  name: string;
  /** Whether the plugin ships in this build and is merely switched off, which
   *  is a one-click fix and a different sentence from "go and install it". */
  installable: boolean;
  /** The feature types it owns that this document actually uses, sorted. */
  types: string[];
  /** How many features are affected, which is what makes the warning
   *  proportionate: one row is a note, forty is a reason not to save over it. */
  count: number;
}

/** feature type -> the plugin that declares it, across everything shipped here.
 *
 *  Read off the SHIPPED MANIFESTS rather than off the loaded contributions,
 *  which is the entire trick: a plugin that is switched off or not installed
 *  contributes nothing, so asking the live registry could only ever answer
 *  "nobody owns this" for precisely the case this file exists to explain.
 *  `featureTypes` in the manifest is what a plugin declares so it can be named
 *  while it is not running. */
function declaredOwners(): Map<string, { id: string; name: string }> {
  const out = new Map<string, { id: string; name: string }>();
  for (const p of shippedPlugins()) {
    for (const t of p.manifest.featureTypes ?? []) {
      if (!out.has(t)) out.set(t, { id: p.manifest.id, name: p.manifest.name });
    }
  }
  return out;
}

/** Whether this build can build a feature of this type right now. */
function buildable(type: string, live: ReadonlySet<string>): boolean {
  return type in FEATURE_NUM_FIELDS || type === "sketch" || live.has(type);
}

/** Every plugin this document needs and does not have, worst first.
 *
 *  Worst first means most-used first: a document with thirty textures and one
 *  feature from something else should read as a texture problem. Ties break by
 *  name so the list is stable between runs and a test can assert on it.
 */
export function missingPlugins(doc: Pick<CadDocument, "features">): MissingPlugin[] {
  const live = new Set(contributedFeatureTypes());
  const owners = declaredOwners();
  // A plugin that ships here is one the person can switch back on; anything
  // else has to be installed, or does not exist at all.
  const shipped = new Set(shippedPlugins().map((p) => p.manifest.id));

  const byKey = new Map<string, MissingPlugin>();
  for (const f of doc.features as Feature[]) {
    const type = f.type;
    if (buildable(type, live)) continue;
    const owner = owners.get(type) ?? null;
    const key = owner?.id ?? `?${type}`;
    let ent = byKey.get(key);
    if (!ent) {
      ent = {
        id: owner?.id ?? null,
        name: owner?.name ?? type,
        installable: owner ? shipped.has(owner.id) : false,
        types: [],
        count: 0,
      };
      byKey.set(key, ent);
    }
    if (!ent.types.includes(type)) ent.types.push(type);
    ent.count++;
  }

  const out = [...byKey.values()];
  for (const e of out) e.types.sort();
  out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return out;
}

/** The sentence to show for one missing plugin.
 *
 *  Written to answer the two questions a person actually has, in order: what
 *  will happen to my file, and what do I do about it. The reassurance comes
 *  FIRST and is unconditional, because the fear this warning creates ("have I
 *  lost the part?") is worse than the problem it reports, and the answer is no.
 */
export function missingPluginMessage(m: MissingPlugin): string {
  const what =
    m.count === 1 ? "One feature in this document is" : `${m.count} features in this document are`;
  const keep =
    "Their settings are kept and will build again once it is back; saving will not drop them.";
  if (m.id === null) {
    return (
      `${what} of a kind this build does not know (${m.types.join(", ")}). ` +
      `${keep} They were probably made by a plugin that is not installed here.`
    );
  }
  const fix = m.installable
    ? `Turn "${m.name}" back on in Plugins to build them.`
    : `Install "${m.name}" to build them.`;
  return `${what} built by "${m.name}", which is not running. ${fix} ${keep}`;
}
