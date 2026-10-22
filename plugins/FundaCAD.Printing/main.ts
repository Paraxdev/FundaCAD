// The app holds no other knowledge that a printer exists, the work is in this directory. None of it is in the bundle
// with the capability off, since plugins/activate.ts imports only this file and only when it is on.

import { activePrinterId, printerProbe, printerFilaments, asPrinterError } from "./printerClient";
import { setPrinterPillClick } from "./printStatusLine";
import { exportPrintProject } from "./exportProject";
import { showCamera } from "./state";
import PrintStatusPill from "./PrintStatusPill.vue";
import CameraPanel from "./CameraPanel.vue";
import FilamentMappingHost from "./FilamentMappingHost.vue";
import { choose, contribute, toast } from "fundacad";
import type { DocumentStore, Engine } from "fundacad";

const ID = "FundaCAD.Printing";

const ICONS: Record<string, string> = {
  print:
    '<path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="8" rx="1.5"/><rect x="7" y="14" width="10" height="6"/><circle cx="17" cy="12" r="0.9" fill="currentColor"/>',
  slicer:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><path d="M11 14h5m0 0l-2-2m2 2l-2 2"/>',
  printerSend:
    '<path d="M6 8V3h9l3 3v2"/><rect x="4" y="8" width="16" height="7" rx="1.5"/><path d="M8 15h5v6H8z"/><path d="M15 19h6m0 0l-2-2m2 2l-2 2"/>',
};

export async function activate(e: Engine): Promise<() => void> {
  // The pill is one of the overlays contributed below, so with this capability off there is nothing to click.
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
        // Where PRINT sat in the app's own collapse order: below MODIFY, above INSPECT.
        priority: 50,
        items: [
          { action: "print-export", label: "Print Project", iconName: "print" },
          { action: "print-orca", label: "Open in OrcaSlicer", iconName: "slicer" },
          { action: "print-send", label: "Send to Printer", iconName: "printerSend" },
        ],
      },
    ],

    // The same three ids the ribbon buttons carry. The app's one dispatcher hands any id it does not recognise to
    // whoever claimed it, from the ribbon, the palette, the keymap and every context menu.
    actions: {
      "print-export": () => void exportPrintProject(e.store, e.geometry),
      "print-orca": () => void flow().then((m) => m.openInOrca(e.store, e.geometry)),
      "print-send": () => void flow().then((m) => m.sendToPrinter(e.store, e.geometry)),
    },

    overlays: [PrintStatusPill, CameraPanel, FilamentMappingHost],

    icons: ICONS,

    // What a machine has loaded, under a name the colour capability's palette panel agrees on, passed through the app.
    // The panel belongs to the palette's owner, so with this off it cannot know what is loaded and draws nothing.
    provides: { filaments: filamentSource() },
  });

  return () => {
    off();
    // Back to doing nothing, rather than to a stale closure over an engine and
    // a panel that a turned-off capability has no business opening.
    setPrinterPillClick(null);
  };
}

/** The `filaments` service: probe, read, and the confirmed sync. */
function filamentSource() {
  return {
    async probe(): Promise<boolean> {
      if (!("__TAURI_INTERNALS__" in window)) return false;
      try {
        return (await printerProbe(activePrinterId())).online;
      } catch {
        return false; // passive, no toast
      }
    },

    read: () => printerFilaments(activePrinterId()),

    async sync(store: DocumentStore): Promise<boolean> {
      if (!("__TAURI_INTERNALS__" in window)) return false;
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
        const cur = store.colorPalette;
        const diff = proposed
          .map((p, i) =>
            p && (cur[i]?.name !== p.name || cur[i]?.color !== p.color)
              ? `Slot ${i + 1}: ${cur[i]?.name ?? ", "} → ${p.name}`
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

      store.replacePaletteSlots(proposed);
      toast("Palette synced from printer.", { kind: "info" });
      return true;
    },
  };
}
