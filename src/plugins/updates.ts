// Plugins offered an update: a newer version, or a same-version bundle the retired Python engine installed with no
// component this engine runs, which a version check alone would call up to date forever.

import { promiseCovers, sameId } from "./manifest";
import { installedManifest, type InstalledPlugin, type OfficialPlugin } from "./index";

export interface PluginUpdate {
  offer: OfficialPlugin;
  /** one sentence for the row */
  reason: string;
  /** whether it may install without showing what it asks for again */
  covered: boolean;
}

/** A part that is missing or not a number counts as 0, so "1.2.0-rc" reads as 1.2.0 rather than failing. */
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

export function updateFor(rec: InstalledPlugin, offered: readonly OfficialPlugin[]): PluginUpdate | null {
  const offer = offered.find((p) => sameId(p.manifest.id, rec.id));
  if (!offer) return null;
  const had = installedManifest(rec);
  const covered = had !== null && promiseCovers(had, offer.manifest);
  const version = offer.manifest.version;
  if (offer.manifest.geometryWasm && !rec.component) {
    return {
      offer,
      covered,
      reason: `This copy was made for the previous engine and has no component for FundaCAD 1.0, so what it adds does not build. Version ${version} has one.`,
    };
  }
  if (compareVersions(version, rec.version) > 0) {
    return { offer, covered, reason: `Version ${version} is available.` };
  }
  return null;
}
