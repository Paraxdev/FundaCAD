// The plugins that ship in this repository, read from the same file that goes
// in their zip.
//
// A PLUGIN IS A DIRECTORY UNDER plugins/ WITH A manifest.json IN IT. That is the
// whole rule, it is the same rule scripts/build-plugins.py follows, and this
// module is what makes the app obey it too. Adding a plugin is adding a
// directory; nothing here is edited, and nothing here names one.
//
// WHY THIS EXISTS AT ALL. There used to be two copies of every shipped
// manifest: one as a JSON literal inside registry.ts or index.ts, and one in
// the plugin's own directory for the bundle to carry. Two copies of a
// permission list is two lists that can disagree, and the one the user reads on
// the consent screen would have been the copy in the app rather than the copy
// that actually runs. Now there is one file. The app reads it at build time,
// the packager reads it at release time, and the installer reads the packaged
// one back out of the zip.
//
// EAGER, and that is deliberate for the manifests only. They are a few hundred
// bytes each and every one of them is needed to draw the Plugins list, so
// deferring them would buy nothing and cost a screen that fills in late. The
// plugins' CODE is a different question and is answered in ./activate.ts, where
// the loading really is lazy.

import { parseManifest, type PluginManifest } from "./manifest";

const RAW = import.meta.glob("../../plugins/*/manifest.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

export interface ShippedPlugin {
  manifest: PluginManifest;
  /** the directory name under plugins/, which is also the id */
  dir: string;
}

/** `plugins/Some.Thing/manifest.json` -> `Some.Thing`. */
function dirOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 2] ?? "";
}

let cache: ShippedPlugin[] | null = null;

/** Every plugin in this repository, in directory order.
 *
 *  THROWS on a manifest it cannot use, rather than skipping it. Two things are
 *  refused, and both are mistakes in this repository rather than conditions to
 *  degrade around:
 *
 *  A manifest the parser rejects. It is written as untrusted JSON and run
 *  through the same `parseManifest` a stranger's bundle gets, which is not
 *  ceremony: it is what stops a shipped plugin describing itself in terms the
 *  consent screen would refuse to render, and what keeps its grant names from
 *  drifting away from the table that spells them out.
 *
 *  An id that disagrees with its directory. The directory name is what the
 *  release asset is named after and what the app installs into, so a manifest
 *  that says something else would install under one name and be looked for
 *  under another. build-plugins.py refuses the same mismatch; this is the half
 *  that fails in a unit test instead of at release time. */
export function shippedPlugins(): ShippedPlugin[] {
  if (cache) return cache;
  const out: ShippedPlugin[] = [];
  for (const path of Object.keys(RAW).sort()) {
    const dir = dirOf(path);
    const parsed = parseManifest(RAW[path]);
    if (!parsed.ok) {
      throw new Error(`plugins/${dir}/manifest.json is not installable: ${parsed.why}`);
    }
    if (parsed.manifest.id !== dir) {
      throw new Error(
        `plugins/${dir}/manifest.json says id ${JSON.stringify(parsed.manifest.id)}, not ${JSON.stringify(dir)}`,
      );
    }
    out.push({ manifest: parsed.manifest, dir });
  }
  cache = out;
  return out;
}

// There used to be two functions here, splitting these into the ones that
// shipped INSIDE the app and the ones packaged as a bundle. Nothing ships inside
// the app any more: every plugin in this repository, `builtin` included, is a
// zip on a release and is installed like anybody else's. `builtin` still means
// something, and what it means is REACH — it runs in the application's own
// JavaScript context — which is a fact about what it can do and never was a
// fact about where it came from.

/** The file name build-plugins.py gives a plugin's zip. One function, so the
 *  app cannot come to expect an asset the packager does not produce. */
export function bundleAsset(id: string): string {
  return `plugin-${id}.zip`;
}
