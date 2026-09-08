// Print-pipeline flows wired to ribbon actions:
//   openInOrca   — export a colored project 3MF to staging, open it in OrcaSlicer
//                  (Stage D.v1). The user slices + Upload&Prints from Orca, whose
//                  U1 preset already carries the printer host.
//   sendToPrinter — pick a sliced .gcode, map its filaments to the U1's loaded
//                  toolheads, upload + start, and monitor progress (Stage D direct
//                  send). In-app slicing (model→gcode) is a later round.

import { exportPrintProject } from "./exportProject";
import { filamentMappingDialog, type LogicalSlot } from "./printDialog";
import { contributedPalette, invoke, openDialog, stripDocumentExt, toast } from "fundacad";
import type { DocumentStore, GeometryBackend } from "fundacad";
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

/** Stage D.v1: colored project 3MF → staging → OrcaSlicer GUI. */
export async function openInOrca(store: DocumentStore, geometry: GeometryBackend) {
  if (!isTauri()) return;
  const stem = stripDocumentExt(store.fileName) || "part";
  let stagingPath: string;
  try {
    stagingPath = await invoke<string>("print_staging_path", { name: stem, ext: "3mf" });
  } catch (e) {
    toast(`Couldn't prepare export: ${String(e)}`, { kind: "error" });
    return;
  }
  // Flatten the user's active OrcaSlicer machine preset so the project OPENS on
  // the U1 (with its print host), not on "-". Non-fatal: without it the export
  // still carries the colors, but Orca won't bind the printer preset.
  let settings: Record<string, unknown> | undefined;
  try {
    settings = await invoke<Record<string, unknown>>("slicer_project_settings", {
      // One filament when nothing offers a palette. The assignments are still
      // in the document and the project still carries whatever colours the
      // bodies were given, but the Orca preset is built for the machine the
      // user actually has, and asking for four is what makes Orca open a
      // toolchanger preset on a single-head printer.
      //
      // Asked of the app rather than of the capability that answers it. This
      // used to read "is multi-material switched on", which is one plugin
      // naming another and holding an opinion about what its being off means.
      // "What colours does this document have" is the question that was
      // actually being asked, and an empty answer is a single-filament print.
      filamentCount: contributedPalette().length || 1,
    });
  } catch (e) {
    console.warn("slicer_project_settings failed, falling back to minimal settings:", e);
  }
  const written = await exportPrintProject(store, geometry, { path: stagingPath, ...(settings !== undefined ? { settings } : {}) });
  if (!written) return; // exportPrintProject already surfaced any error
  try {
    await invoke("slicer_open", { path: written });
    toast(
      settings
        ? "Opened in OrcaSlicer on your U1 preset, slice, then Upload & Print."
        : "Opened in OrcaSlicer, pick your U1 printer, slice, then Upload & Print.",
    );
  } catch (e) {
    toast(`Couldn't launch OrcaSlicer: ${String(e)}`, { kind: "error" });
  }
}

/** the palette slots this document actually prints (logical gcode tools).
 *
 *  Exactly one when no palette is offered, whatever the document says. The
 *  assignments are still there — this is what a single-material print IS, and
 *  the alternative is to ask someone with one toolhead which of their four
 *  toolheads each colour goes in. */
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

/** Stage D direct send: pick a sliced .gcode, map filaments, upload + start. */
export async function sendToPrinter(store: DocumentStore, _geometry: GeometryBackend) {
  if (!isTauri()) return;
  const id = activePrinterId();

  // pick the sliced gcode (from Orca) — the native dialog is the trust boundary.
  const picked = await openDialog({ filters: [{ name: "G-code", extensions: ["gcode"] }] });
  if (!picked) return;

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

  const remoteName = picked.split(/[\\/]/).pop() || "part.gcode";
  try {
    await printerUploadAndPrint(id, picked, remoteName, mapping.mapTable, mapping.opts);
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

/** subscribe to Rust status frames → status line + terminal toast. Idempotent. */
async function startMonitoring(id: string) {
  const { setPrinterStatusText } = await import("./printStatusLine");
  statusUnlisten?.();
  const offStatus = await onPrinterStatus((s) => {
    if (s.id !== id) return;
    if (s.state === "printing" || s.state === "paused") {
      setPrinterStatusText(`${s.state === "paused" ? "Paused" : "Printing"} ${s.filename} — ${Math.round(s.progress * 100)}%`);
    } else {
      setPrinterStatusText(null);
      if (s.state === "complete") toast(`Print complete: ${s.filename}`, { kind: "info" });
      else if (s.state === "error") toast(`Print error on ${s.filename}`, { kind: "error" });
      cleanup();
    }
  });
  const offOffline = await onPrinterOffline((oid) => {
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
  await printerMonitorStart(id);
}
