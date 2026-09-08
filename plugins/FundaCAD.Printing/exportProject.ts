// The colored 3MF PROJECT export, and the post-export check that goes with it.
//
// This used to be two functions and a settings table in src/io/files.ts, beside
// the app's own STEP/STL/3MF export. It is not one of those. A project 3MF is
// aimed at one slicer, carries a preset naming one printer model, maps palette
// slots onto physical toolheads, and finishes by asking a machine on the network
// which filaments it has loaded. Every sentence in it is about a printer, which
// is why it lives with the printer.
//
// The app's own `exportModel` is unchanged and still writes 3MF among its
// formats. The difference is the word PROJECT: one object per body with a
// toolhead assignment each, rather than one mesh.

import { contributedPalette, listModal, reportError, saveDialog, stripDocumentExt, toast } from "fundacad";
import type { DocumentStore, GeometryBackend } from "fundacad";

const isTauri = () => "__TAURI_INTERNALS__" in window;

// The slicer preset the exported project should land on — minimal keys Orca needs
// to select the user's Snapmaker U1 machine on "open as project". Stage D.v2 (CLI)
// overrides these with a fully-flattened config via `opts.settings`.
const U1_PROJECT_SETTINGS: Record<string, unknown> = {
  printer_model: "Snapmaker U1",
  printer_variant: "0.4",
  version: "2.4.0.0",
};

/** Export a colored multi-material 3MF PROJECT (Orca format): one object per body,
 *  palette slot → toolhead, so the multi-color palette actually prints. With
 *  `opts.path` it writes there silently (Stage D staging → open in Orca); without,
 *  it prompts with a save dialog. Returns the written path, or null (cancelled /
 *  error). Palette/bodyColors/bodyNames are threaded explicitly — they live in
 *  store side-maps, never inside `document`. */
export async function exportPrintProject(
  store: DocumentStore,
  geometry: GeometryBackend,
  opts: { path?: string; settings?: Record<string, unknown> } = {},
): Promise<string | null> {
  if (!isTauri()) {
    console.warn("print export needs the native app (a real filesystem path)");
    return null;
  }
  if (!geometry.exportProject) {
    await reportError("Colored 3MF export needs the Python sidecar backend (run without VITE_GEOM=rust).");
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

  // Same busy/cancel treatment as the app's own export and import — this path
  // tessellates every body at export grade before writing the project, so it is
  // every bit as long-running as a plain export on a large document.
  const res = await store.runBusy(
    `Exporting ${path.split(/[\\/]/).pop() ?? "project"}`,
    (onStarted) => geometry.exportProject!(store.document, path, {
      palette: store.colorPalette,
      bodyColors: store.bodyColorsMap(),
      bodyNames: store.bodyNamesMap(),
      settings: { ...U1_PROJECT_SETTINGS, ...(opts.settings ?? {}) },
    }, onStarted),
  );
  if (!res.ok) {
    if (res.cancelled) return null;  // the user stopped it — not an error
    await reportError(`Print export failed: ${res.message ?? "unknown error"}`);
    return null;
  }
  void warnUnloadedFilaments(store, bodies.map((b) => b.id));
  // Only surface a modal when there are warnings (features that didn't build) —
  // the silent-staging path (Stage D) shouldn't pop a dialog on the happy path.
  if (res.warnings?.length) {
    const lines = res.warnings.map(
      (w) => `Warning: ${w.feature_id ?? "feature"} failed, its result is NOT in the export: ${w.message}`,
    );
    await listModal("Exported project, with warnings", [res.path ?? path, ...lines]);
  }
  return res.path ?? path;
}

/** Best-effort post-export check: warn when the design uses palette slots whose
 *  toolhead has no filament loaded, or leaves bodies unassigned (they export as
 *  extruder 1). Fire-and-forget and bounded to 1.5s client-side (the shared
 *  Rust HTTP client has a 10s timeout — a warning arriving that late is worse
 *  than none): unreachable/slow/unconfigured printer → silently no warning.
 *  Never blocks or fails the export itself.
 *
 *  Silent when nothing offers a palette. Every sentence it can produce is about
 *  toolheads and slot assignments — "3 bodies are unassigned (defaulting to
 *  slot 1)" is a warning about a choice the user was never offered. */
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
        usedSlots.add(0); // project3mf defaults unassigned bodies to slot 0
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
    // printer offline/slow/unconfigured — the check is best-effort by design
  }
}
