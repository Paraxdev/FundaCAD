// Features needing a plugin that is not here. The file still opens and keeps every value; this is the document-level
// summary, while the engine's plugin_geometry.unregistered turns each feature's row red.

import { contributedFeatureTypes } from "../plugins/contrib";
import { shippedPlugins } from "../plugins/shipped";
import { isCoreFeatureType, type CadDocument, type Feature } from "../types";

export interface MissingPlugin {
  // Null when nothing claims the type.
  id: string | null;
  // The feature type itself when nothing claims it.
  name: string;
  // Shipped but switched off: a one-click fix, and a different sentence from "go and install it".
  installable: boolean;
  types: string[];
  // One row is a note, forty is a reason not to save over it.
  count: number;
}

// Read off the shipped manifests, not the live registry: a disabled plugin contributes nothing, so the registry
// would answer "nobody owns this" for exactly the case this explains.
function declaredOwners(): Map<string, { id: string; name: string }> {
  const out = new Map<string, { id: string; name: string }>();
  for (const p of shippedPlugins()) {
    for (const t of p.manifest.featureTypes ?? []) {
      if (!out.has(t)) out.set(t, { id: p.manifest.id, name: p.manifest.name });
    }
  }
  return out;
}

export function featureTypeOwner(type: string): { id: string; name: string } | null {
  return declaredOwners().get(type) ?? null;
}

function buildable(type: string, live: ReadonlySet<string>): boolean {
  return isCoreFeatureType(type) || live.has(type);
}

// Most-used first, so thirty textures and one other feature read as a texture problem. Ties by name for stable tests.
export function missingPlugins(doc: Pick<CadDocument, "features">): MissingPlugin[] {
  const live = new Set(contributedFeatureTypes());
  const owners = declaredOwners();
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

// Reassurance first ("your file is safe"), then what to do. A type no shipped plugin declares is openNotice.ts's job.
export function missingPluginMessage(m: MissingPlugin & { id: string }): string {
  const what = m.count === 1 ? "One feature in this document is" : `${m.count} features in this document are`;
  const keep = "Their settings are kept and will build again once it is back; saving will not drop them.";
  const fix = m.installable
    ? `Turn "${m.name}" back on in Plugins to build them.`
    : `Install "${m.name}" to build them.`;
  return `${what} built by "${m.name}", which is not running. ${fix} ${keep}`;
}
