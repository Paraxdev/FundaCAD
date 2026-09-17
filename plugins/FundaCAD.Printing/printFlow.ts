// Print-pipeline flows wired to ribbon actions:
//   openInOrca, export a colored project 3MF to staging, open it in OrcaSlicer.
//                  The user slices + Upload&Prints from Orca, whose U1 preset
//                  already carries the printer host.
//   sendToPrinter, pick a sliced .gcode, map its filaments to the U1's loaded
//                  toolheads, upload + start, and monitor progress.

import { exportPrintProject } from "./exportProject";
import { filamentMappingDialog, type LogicalSlot } from "./printDialog";
import { contributedPalette, stripDocumentExt, toast } from "fundacad";
import type { DocumentStore, GeometryBackend } from "fundacad";
import { dataPath, launch, pickFile, systemDirs } from "./native";
import { slicerSetup } from "./slicer";
import {
  activePrinterId,
  asPrinterError,
  onPrinterOffline,
  onPrinterStatus,
  printerFilaments,
  printerMonitorStart,
  printerUploadAndPrint,
  type ToolheadFilament,
} from "./printerClient";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** A staging file name: a sanitized stem, like a recovery slot's. */
export function stagingName(stem: string): string {
  const safe = stem.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return `${safe || "part"}.3mf`;
}

/** Colored project 3MF → staging → OrcaSlicer GUI. */
export async function openInOrca(store: DocumentStore, geometry: GeometryBackend) {
  if (!isTauri()) return;
  let stagingPath: string;
  let setup: Awaited<ReturnType<typeof slicerSetup>>;
  try {
    stagingPath = await dataPath(stagingName(stripDocumentExt(store.fileName) || "part"));
    setup = await slicerSetup(await systemDirs());
  } catch (e) {
    toast(`Couldn't prepare export: ${String(e)}`, { kind: "error" });
    return;
  }
  // The user's active OrcaSlicer machine preset is flattened into the project so
  // it OPENS on the U1 (with its print host), not on "-". Not fatal when it
  // cannot be: the export still carries the colors.
  const written = await exportPrintProject(store, geometry, {
    path: stagingPath,
    presets: {
      datadir: setup.datadir,
      // One filament when nothing offers a palette: the Orca preset is built for
      // the machine the user actually has, and asking for four is what makes Orca
      // open a toolchanger preset on a single-head printer.
      filamentCount: contributedPalette().length || 1,
    },
  });
  if (!written) return; // exportPrintProject already surfaced any error
  if (!written.path.toLowerCase().endsWith(".3mf")) {
    toast("Couldn't launch OrcaSlicer: expected a .3mf project", { kind: "error" });
    return;
  }
  try {
    await launch(setup.programs, [written.path]);
    toast(
      written.presets
        ? "Opened in OrcaSlicer on your U1 preset, slice, then Upload & Print."
        : "Opened in OrcaSlicer, pick your U1 printer, slice, then Upload & Print.",
    );
  } catch (e) {
    toast(`Couldn't launch OrcaSlicer: ${String(e)}`, { kind: "error" });
  }
}

/** the palette slots this document actually prints (logical gcode tools).
 *
 *  Exactly one when no palette is offered, whatever the document says: that is
 *  what a single-material print IS, and the alternative is asking someone with
 *  one toolhead which of their four toolheads each colour goes in. */
function usedSlots(store: DocumentStore): LogicalSlot[] {
  const palette = contributedPalette();
  const used = new Set<number>();
  if (palette.length) {
    for (const v of Object.values(store.bodyColorsMap())) used.add(v);
  }
  if (store.buildState.result?.bodies?.length) used.add(0); // unassigned → extruder 1
  if (!used.size) used.add(0);
  return [...used]
    .sort((a, b) => a - b)
    .map((i) => {
      const mat = palette[i]?.material;
      return {
        index: i,
        name: palette[i]?.name ?? `Filament ${i + 1}`,
        color: palette[i]?.color ?? "#808080",
        ...(mat !== undefined ? { material: mat } : {}),
      };
    });
}

let statusUnlisten: (() => void) | null = null;

/** Pick a sliced .gcode, map filaments, upload + start. */
export async function sendToPrinter(store: DocumentStore, _geometry: GeometryBackend) {
  if (!isTauri()) return;
  const id = activePrinterId();

  // The sliced job from Orca. The native dialog is the trust boundary, and what
  // comes back is a handle, so the upload can only ever send this file.
  let picked;
  try {
    picked = await pickFile("Choose the sliced G-code to send", ["gcode"]);
  } catch (e) {
    toast(`Couldn't open the file: ${String(e)}`, { kind: "error" });
    return;
  }
  if (!picked) return;
  if (!picked.name.toLowerCase().endsWith(".gcode")) {
    toast("Expected a .gcode file.", { kind: "error" });
    return;
  }

  let toolheads: ToolheadFilament[];
  try {
    toolheads = await printerFilaments(id);
  } catch (e) {
    const pe = asPrinterError(e);
    toast(pe ? `Can't reach the printer: ${pe.message}` : `Printer error: ${String(e)}`, { kind: "error" });
    return;
  }

  const mapping = await filamentMappingDialog(usedSlots(store), toolheads);
  if (!mapping) return;

  const remoteName = picked.name || "part.gcode";
  try {
    await printerUploadAndPrint(id, picked.handle, remoteName, mapping.mapTable, mapping.opts);
  } catch (e) {
    const pe = asPrinterError(e);
    if (pe?.code === "Busy") toast("Printer is busy, job not sent.", { kind: "error" });
    else if (pe?.code === "NozzleMismatch") toast(`Nozzle mismatch, ${pe.message}`, { kind: "error" });
    else if (pe?.code === "Unreachable") toast("Printer not reachable, is it on?", { kind: "error" });
    else toast(pe ? `Print rejected: ${pe.message}` : `Send failed: ${String(e)}`, { kind: "error" });
    return;
  }

  toast(`Sent ${remoteName}, printing`, { kind: "info" });
  void startMonitoring(id);
}

/** status frames → status line + terminal toast. Idempotent. */
async function startMonitoring(id: string) {
  const { setPrinterStatusText } = await import("./printStatusLine");
  statusUnlisten?.();
  const offStatus = onPrinterStatus((s) => {
    if (s.id !== id) return;
    if (s.state === "printing" || s.state === "paused") {
      setPrinterStatusText(`${s.state === "paused" ? "Paused" : "Printing"} ${s.filename}, ${Math.round(s.progress * 100)}%`);
    } else {
      setPrinterStatusText(null);
      if (s.state === "complete") toast(`Print complete: ${s.filename}`, { kind: "info" });
      else if (s.state === "error") toast(`Print error on ${s.filename}`, { kind: "error" });
      cleanup();
    }
  });
  const offOffline = onPrinterOffline((oid) => {
    if (oid !== id) return;
    setPrinterStatusText(null);
    toast("Lost connection to the printer.", { kind: "error" });
    cleanup();
  });
  const cleanup = () => {
    offStatus();
    offOffline();
    statusUnlisten = null;
  };
  statusUnlisten = cleanup;
  try {
    await printerMonitorStart(id);
  } catch {
    cleanup();
  }
}
