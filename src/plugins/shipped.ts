// The plugins in this repository, one per directory under plugins/ with a manifest.json, read from the file its zip
// carries, so the consent screen and the bundle cannot disagree. Eager, since the Plugins list needs every manifest.

import { parseManifest, type PluginManifest } from "./manifest";

const RAW = import.meta.glob("../../plugins/*/manifest.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

export interface ShippedPlugin {
  manifest: PluginManifest;
  /** also the id */
  dir: string;
}

/** `plugins/Some.Thing/manifest.json` -> `Some.Thing`. */
function dirOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 2] ?? "";
}

let cache: ShippedPlugin[] | null = null;

/** Throws rather than skips: a manifest parseManifest rejects, or an id that disagrees with its directory, is a mistake
 *  in this repository. build-plugins.py refuses the same mismatch at release time; this fails in a unit test. */
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

/** One function, so the app cannot come to expect an asset the packager does not produce. */
export function bundleAsset(id: string): string {
  return `plugin-${id}.zip`;
}

/** The manifest `name`, or the id when nothing ships under it, so the selection rail reads "3D Printing Toolbox". */
export function shippedPluginName(id: string): string {
  return shippedPlugins().find((p) => p.dir === id)?.manifest.name ?? id;
}
