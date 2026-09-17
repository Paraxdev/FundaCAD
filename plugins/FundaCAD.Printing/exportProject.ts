// The colored 3MF PROJECT export, and the post-export check that goes with it.
//
// A project 3MF is aimed at one slicer, carries a preset naming one printer
// model, maps palette slots onto physical toolheads, and finishes by asking a
// machine on the network which filaments it has loaded. The file itself is
// written by this plugin's exporter inside the geometry engine
// (geometry/register.py), which the app reaches through its generic
// `exportWith`.
//
// The app's own `Export…` is unchanged and still writes 3MF among its formats.
// The difference is the word PROJECT: one object per body with a toolhead
// assignment each, rather than one mesh.

import { contributedPalette, listModal, reportError, saveDialog, stripDocumentExt, toast } from "fundacad";
import type { DocumentStore, GeometryBackend } from "fundacad";

const isTauri = () => "__TAURI_INTERNALS__" in window;

export const PROJECT_EXPORTER = "print-project-3mf";

export interface ProjectExport {
  path: string;
  /** Whether the user's slicer presets were flattened into the project, when asked. */
  presets?: boolean;
}

/** Export a colored multi-material 3MF PROJECT (Orca format): one object per body,
 *  palette slot → toolhead. With `opts.path` it writes there silently (the
 *  staging path the slicer hand-off opens); without, it prompts with a save
 *  dialog. `opts.presets` asks the exporter to flatten the user's slicer presets
 *  into the project. Returns null when cancelled or failed. */
export async function exportPrintProject(
  store: DocumentStore,
  geometry: GeometryBackend,
  opts: { path?: string; presets?: { datadir: string | null; filamentCount: number } } = {},
): Promise<ProjectExport | null> {
  if (!isTauri()) {
    console.warn("print export needs the native app (a real filesystem path)");
    return null;
  }
  if (!geometry.exportWith) {
    await reportError("Colored 3MF export is not available with this geometry engine yet.");
    return null;
  }
  const bodies = store.buildState.result?.bodies ?? [];
  if (!bodies.length) {
    await reportError("Nothing to export yet, build a body first.");
    return null;
  }

  let path = opts.path;
  if (!path) {
    const base = stripDocumentExt(store.fileName) || "part";
    const picked = await saveDialog({
      filters: [{ name: "3MF project", extensions: ["3mf"] }],
      defaultPath: `${base}.3mf`,
    });
    if (!picked) return null;
    path = picked;
  }

  const options: Record<string, unknown> = {
    palette: store.colorPalette,
    bodyColors: store.bodyColorsMap(),
    bodyNames: store.bodyNamesMap(),
  };
  if (opts.presets) options.presets = opts.presets;

  // Same busy/cancel treatment as the app's own export and import: this path
  // tessellates every body at export grade before writing the project.
  const res = await store.runBusy(
    `Exporting ${path.split(/[\\/]/).pop() ?? "project"}`,
    (onStarted) => geometry.exportWith!(store.document, path, PROJECT_EXPORTER, options, onStarted),
  );
  if (!res.ok) {
    if (res.cancelled) return null;
    await reportError(`Print export failed: ${res.message ?? "unknown error"}`);
    return null;
  }
  void warnUnloadedFilaments(store, bodies.map((b) => b.id));
  // Only a modal when there are warnings (features that didn't build); the
  // silent staging path shouldn't pop a dialog on the happy path.
  if (res.warnings?.length) {
    const lines = res.warnings.map(
      (w) => `Warning: ${w.feature_id ?? "feature"} failed, its result is NOT in the export: ${w.message}`,
    );
    await listModal("Exported project, with warnings", [res.path ?? path, ...lines]);
  }
  const out: ProjectExport = { path: res.path ?? path };
  if (typeof res.info?.presets === "boolean") out.presets = res.info.presets;
  if (res.info?.presetError) console.warn("slicer presets not flattened:", res.info.presetError);
  return out;
}

/** Best-effort post-export check: warn when the design uses palette slots whose
 *  toolhead has no filament loaded, or leaves bodies unassigned (they export as
 *  extruder 1). Fire-and-forget and bounded to 1.5 s: an unreachable, slow or
 *  unconfigured printer means no warning. Never blocks or fails the export.
 *
 *  Silent when nothing offers a palette. Every sentence it can produce is about
 *  toolheads and slot assignments, which is a choice the user was never offered. */
async function warnUnloadedFilaments(store: DocumentStore, bodyIds: string[]) {
  if (!contributedPalette().length) return;
  try {
    const { activePrinterId, printerFilaments } = await import("./printerClient");
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500));
    const filaments = await Promise.race([printerFilaments(activePrinterId()), timeout]);
    const assigned = store.bodyColorsMap();
    const usedSlots = new Set<number>();
    let unassigned = 0;
    for (const id of bodyIds) {
      const slot = assigned[id];
      if (slot == null) {
        unassigned++;
        usedSlots.add(0); // the exporter defaults unassigned bodies to slot 0
      } else {
        usedSlots.add(slot);
      }
    }
    const empty = [...usedSlots].filter((s) => !filaments[s]?.present).sort();
    if (!empty.length && !unassigned) return;
    const parts: string[] = [];
    if (empty.length) {
      parts.push(`slot${empty.length > 1 ? "s" : ""} ${empty.map((s) => s + 1).join(", ")} ha${empty.length > 1 ? "ve" : "s"} no filament loaded on the printer`);
    }
    if (unassigned) parts.push(`${unassigned} bod${unassigned > 1 ? "ies are" : "y is"} unassigned (defaulting to slot 1)`);
    toast(`Exported, but ${parts.join("; ")}.`, { kind: "warning" });
  } catch {
    // printer offline/slow/unconfigured, the check is best-effort by design
  }
}
