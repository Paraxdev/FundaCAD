// Where OrcaSlicer is on this machine, and where it keeps its presets.
//
// Stored as `slicer.json` in this plugin's data directory, `{ slicer_path,
// orca_datadir }`, the same shape the app shell's own settings file had, which is
// why that file can simply be moved here on first use. With nothing stored, the
// usual install locations are tried in order.

import type { SystemDirs } from "./native";
import { readPluginFile } from "./printerClient";

export interface SlicerSettings {
  slicer_path: string;
  orca_datadir: string;
}

function join(os: string, base: string, ...rest: string[]): string {
  const sep = os === "windows" ? "\\" : "/";
  const parts = rest.flatMap((r) => r.split("/"));
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

/** Where OrcaSlicer usually installs, most likely first. */
export function slicerCandidates(dirs: SystemDirs): string[] {
  const out: string[] = [];
  const add = (base: string | null | undefined, rel: string) => {
    if (base) out.push(join(dirs.os, base, rel));
  };
  if (dirs.os === "windows") {
    add(dirs.programs[0], "OrcaSlicer/orca-slicer.exe");
    add(dirs.localData, "Programs/OrcaSlicer/orca-slicer.exe");
    add(dirs.programs[1], "OrcaSlicer/orca-slicer.exe");
  } else if (dirs.os === "macos") {
    out.push("/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer");
    add(dirs.home, "Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer");
  } else {
    add(dirs.home, "Applications/OrcaSlicer_V2.4.0-alpha.AppImage");
    add(dirs.home, "Applications/OrcaSlicer.AppImage");
    out.push("/usr/bin/orca-slicer", "/usr/local/bin/orca-slicer");
    out.push("/var/lib/flatpak/exports/bin/io.github.softfever.OrcaSlicer");
  }
  return out;
}

/** OrcaSlicer's data directory: %APPDATA%, ~/Library/Application Support or
 *  ~/.config, which is the per-user settings directory the app reports. */
export function orcaDatadir(dirs: SystemDirs): string | null {
  return dirs.config ? join(dirs.os, dirs.config, "OrcaSlicer") : null;
}

export async function storedSlicerSettings(): Promise<Partial<SlicerSettings>> {
  const text = await readPluginFile("slicer.json");
  if (!text) return {};
  try {
    const v = JSON.parse(text) as Partial<SlicerSettings>;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** The programs to try, and the preset directory, for this machine. */
export async function slicerSetup(dirs: SystemDirs): Promise<{ programs: string[]; datadir: string | null }> {
  const stored = await storedSlicerSettings();
  return {
    programs: stored.slicer_path ? [stored.slicer_path] : slicerCandidates(dirs),
    datadir: stored.orca_datadir || orcaDatadir(dirs),
  };
}
