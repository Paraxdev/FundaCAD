// Which installed plugins the Plugins section offers to update, and why.
//
// Two reasons, and the second is why this exists. A newer version is the usual
// one. The other is a bundle whose version says it is current and whose files
// cannot run on this engine: the retired Python engine build and this app share
// one plugin directory, that build installed bundles with only a Python half,
// and this app's bundle of the SAME version carries the component its engine
// runs.
// Compared by version alone such a bundle would look up to date forever, while
// every feature it owns fails to build.

import { promiseCovers, sameId } from "./manifest";
import { installedManifest, type InstalledPlugin, type OfficialPlugin } from "./index";

export interface PluginUpdate {
  offer: OfficialPlugin;
  /** one sentence for the row */
  reason: string;
  /** whether it may install without showing what it asks for again */
  covered: boolean;
}

/** Dotted numbers compared number by number, a missing part counting as 0. A
 *  part that is not a number compares as 0 too, so a tag like "1.2.0-rc" reads
 *  as 1.2.0 rather than failing. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map((p) => parseInt(p, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** The update to offer for one installed plugin, or null. */
export function updateFor(
  rec: InstalledPlugin,
  offered: readonly OfficialPlugin[],
): PluginUpdate | null {
  const offer = offered.find((p) => sameId(p.manifest.id, rec.id));
  if (!offer) return null;
  const had = installedManifest(rec);
  const covered = had !== null && promiseCovers(had, offer.manifest);
  const version = offer.manifest.version;
  if (offer.manifest.geometryWasm && !rec.component) {
    return {
      offer,
      covered,
      reason:
        `This copy was made for the previous engine and has no component for FundaCAD 1.0, so what it adds does not build. Version ${version} has one.`,
    };
  }
  if (compareVersions(version, rec.version) > 0) {
    return { offer, covered, reason: `Version ${version} is available.` };
  }
  return null;
}
