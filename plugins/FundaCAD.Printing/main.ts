// The printer capability: a machine on the network, a slicer on this one, and
// everything the app shows on their behalf.
//
// THE APP CONTAINS NO OTHER KNOWLEDGE THAT A PRINTER EXISTS. It used to contain
// a great deal: three rows in the File menu behind a capability check, a PRINT
// group in the ribbon plus a set of action ids to filter back out of it again,
// three cases in the action dispatcher, three of those ids in the
// non-repeatable table, three overlay components mounted by App.vue behind two
// mirrored flags, a `camera` field on the panels store, a `filament` field and a
// printer-typed request on the dialogs store, a colored-3MF project exporter in
// io/files.ts, and a printer probe with a thirty-second staleness poll inside
// the browser panel. Every one of those was a place a person adding a second
// kind of machine would have had to edit.
//
// What is left is this file. The work is in this directory: the typed wrappers
// over the Rust commands (printerClient), the two flows (printFlow), the
// filament mapping (printDialog), the project export (exportProject), the
// status pill, the camera and the mapping dialog. None of it is in the bundle
// on a machine with the capability switched off, because plugins/activate.ts
// only ever imports this file, and only when it is on.

import { contribute } from "../../src/plugins/contrib";
import { activePrinterId, printerProbe, printerFilaments, asPrinterError } from "./printerClient";
import { setPrinterPillClick } from "./printStatusLine";
import { exportPrintProject } from "./exportProject";
import { showCamera } from "./state";
import PrintStatusPill from "./PrintStatusPill.vue";
import CameraPanel from "./CameraPanel.vue";
import FilamentMappingHost from "./FilamentMappingHost.vue";
import type { DocumentStore } from "../../src/document/store";
import type { Engine } from "../../src/app/engine";

const ID = "FundaCAD.Printing";

/** Start the capability. Returns the teardown that stops it. */
export async function activate(e: Engine): Promise<() => void> {
  // Clicking the live print-progress pill opens the camera on the active
  // printer. The pill is one of the overlays contributed below, so with this
  // capability off there is nothing to click.
  setPrinterPillClick(() => showCamera(activePrinterId()));

  // Imported when used, not when the capability starts: the slicer bridge is a
  // chunk of its own and neither flow is reached by opening a menu.
  const flow = () => import("./printFlow");

  const off = contribute(ID, {
    menus: [
      {
        menu: "File",
        items: [
          { separator: true, label: "" },
          {
            label: "Export for Print (3MF)…",
            onClick: () => void exportPrintProject(e.store, e.geometry),
          },
          {
            label: "Open in OrcaSlicer…",
            onClick: () => void flow().then((m) => m.openInOrca(e.store, e.geometry)),
          },
          {
            label: "Send to Printer…",
            onClick: () => void flow().then((m) => m.sendToPrinter(e.store, e.geometry)),
          },
          { label: "Camera…", onClick: () => showCamera(activePrinterId()) },
        ],
      },
    ],

    ribbon: [
      {
        group: "PRINT",
        // Where PRINT sat in the app's own collapse order before it was one of
        // the app's own groups: below MODIFY, above INSPECT.
        priority: 50,
        items: [
          { action: "print-export", label: "Print Project", iconName: "print" },
          { action: "print-orca", label: "Open in OrcaSlicer", iconName: "slicer" },
          { action: "print-send", label: "Send to Printer", iconName: "printerSend" },
        ],
      },
    ],

    // The same three ids the ribbon buttons carry. They reach the app's one
    // dispatcher from the ribbon, the command palette, the keymap and every
    // context menu, and it hands anything it does not recognise to whoever
    // claimed it.
    actions: {
      "print-export": () => void exportPrintProject(e.store, e.geometry),
      "print-orca": () => void flow().then((m) => m.openInOrca(e.store, e.geometry)),
      "print-send": () => void flow().then((m) => m.sendToPrinter(e.store, e.geometry)),
    },

    overlays: [PrintStatusPill, CameraPanel, FilamentMappingHost],

    // What a machine has loaded in its toolheads, offered to whoever wants it.
    //
    // The palette panel is not here, and this is why: a palette is a list of
    // colours in a document, which is the colour capability's subject, while
    // "what is actually loaded in slot 3 right now" can only be answered by
    // something that can reach the machine. Neither can draw that panel alone.
    // So the panel belongs to the one that owns the data, and this contributes
    // the answer under a name the two of them agree on — through the app, which
    // stores it and hands it back without ever looking inside.
    //
    // The consequence worth having: with this capability off, the panel is not
    // hidden by a check, it has no way to know whether anything is loaded and
    // so it draws nothing, which is what it should do on a machine with no
    // printer anyway.
    provides: { filaments: filamentSource() },
  });

  return () => {
    off();
    // Back to doing nothing, rather than to a stale closure over an engine and
    // a panel that a turned-off capability has no business opening.
    setPrinterPillClick(null);
  };
}

/** The `filaments` service: probe, read, and the confirmed sync.
 *
 *  The sync flow — diff, confirm before overwriting a customised palette, apply
 *  — used to be a hundred lines inside the browser panel. It is a printer
 *  operation that happens to write into a document, and it reads much better
 *  from the printer's side. */
function filamentSource() {
  return {
    async probe(): Promise<boolean> {
      if (!("__TAURI_INTERNALS__" in window)) return false;
      try {
        return (await printerProbe(activePrinterId())).online;
      } catch {
        return false; // passive — no toast
      }
    },

    read: () => printerFilaments(activePrinterId()),

    async sync(store: DocumentStore): Promise<boolean> {
      if (!("__TAURI_INTERNALS__" in window)) return false;
      const { toast } = await import("../../src/ui/toast");
      let filaments;
      try {
        filaments = await printerFilaments(activePrinterId());
      } catch (err) {
        const pe = asPrinterError(err);
        toast(pe ? `Can't reach the printer: ${pe.message}` : `Printer error: ${String(err)}`, {
          kind: "error",
        });
        return false;
      }

      // one proposed slot per loaded toolhead; empty toolheads leave the slot alone.
      const proposed = filaments.map((f) =>
        f.present
          ? {
            name: `${f.vendor} ${f.material}`.trim() || `Toolhead ${f.index + 1}`,
            color: f.color,
            material: f.material,
          }
          : undefined,
      );
      if (!proposed.some(Boolean)) {
        toast("No filament loaded on the printer.", { kind: "info" });
        return false;
      }

      if (!store.paletteIsDefault()) {
        const { choose } = await import("../../src/ui/choice");
        const cur = store.colorPalette;
        const diff = proposed
          .map((p, i) =>
            p && (cur[i]?.name !== p.name || cur[i]?.color !== p.color)
              ? `Slot ${i + 1}: ${cur[i]?.name ?? "—"} → ${p.name}`
              : null,
          )
          .filter(Boolean) as string[];
        const go = await choose<"apply" | "cancel">(
          diff.length ? `Overwrite palette from printer?\n${diff.join("\n")}` : "Sync palette from printer?",
          [
            { value: "apply", label: "Overwrite", hint: `${diff.length} slot${diff.length === 1 ? "" : "s"}` },
            { value: "cancel", label: "Cancel" },
          ],
        );
        if (go !== "apply") return false;
      }

      store.applyFilamentSync(proposed);
      toast("Palette synced from printer.", { kind: "info" });
      return true;
    },
  };
}
