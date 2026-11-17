// The app holds no other knowledge that a printer exists, the work is in this directory. None of it is in the bundle
// with the capability off, since plugins/activate.ts imports only this file and only when it is on.

import { activePrinterId, printerProbe, printerFilaments, asPrinterError } from "./printerClient";
import { setPrinterPillClick } from "./printStatusLine";
import { exportPrintProject } from "./exportProject";
import { ICONS } from "./icons";
import { showCamera } from "./state";
import { t } from "./lines";
import PrintStatusPill from "./PrintStatusPill.vue";
import CameraPanel from "./CameraPanel.vue";
import FilamentMappingHost from "./FilamentMappingHost.vue";
import { choose, contribute, toast } from "fundacad";
import type { DocumentStore, Engine } from "fundacad";

const ID = "FundaCAD.Printing";

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
            label: () => t("menu.file.exportPrint"),
            refName: "Export for Print (3MF)…",
            onClick: () => void exportPrintProject(e.store, e.geometry),
          },
          {
            label: () => t("menu.file.openSlicer"),
            refName: "Open in OrcaSlicer…",
            onClick: () => void flow().then((m) => m.openInOrca(e.store, e.geometry)),
          },
          {
            label: () => t("menu.file.send"),
            refName: "Send to Printer…",
            onClick: () => void flow().then((m) => m.sendToPrinter(e.store, e.geometry)),
          },
          { label: () => t("menu.file.camera"), refName: "Camera…", onClick: () => showCamera(activePrinterId()) },
        ],
      },
    ],

    ribbon: [
      {
        group: "PRINT",
        get label() {
          return t("group.print");
        },
        // Where PRINT sat in the app's own collapse order: below MODIFY, above INSPECT.
        priority: 50,
        items: [
          {
            action: "print-export",
            get label() {
              return t("tool.export");
            },
            refName: "Print Project",
            iconName: "print",
          },
          {
            action: "print-orca",
            get label() {
              return t("tool.openSlicer");
            },
            refName: "Open in OrcaSlicer",
            iconName: "slicer",
          },
          {
            action: "print-send",
            get label() {
              return t("tool.send");
            },
            refName: "Send to Printer",
            iconName: "printerSend",
          },
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

/** The palette keeps the English default name, so a sync compares the same text in every language. */
function shownName(name: string): string {
  const m = /^Toolhead (\d+)$/.exec(name);
  return m ? t("toolhead.name", { n: Number(m[1]) }) : name;
}

/** The `filaments` service: probe, read, and the confirmed sync. */
export function filamentSource() {
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
        toast(pe ? t("error.unreachable", { message: pe.message }) : t("error.printer", { message: String(err) }), {
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
        toast(t("toast.noFilament"), { kind: "info" });
        return false;
      }

      if (!store.paletteIsDefault()) {
        const cur = store.colorPalette;
        const diff = proposed
          .map((p, i) =>
            p && (cur[i]?.name !== p.name || cur[i]?.color !== p.color)
              ? t("sync.slotLine", {
                  n: i + 1,
                  old: cur[i] ? shownName(cur[i].name) : t("sync.emptySlot"),
                  new: shownName(p.name),
                })
              : null,
          )
          .filter(Boolean) as string[];
        const go = await choose<"apply" | "cancel">(
          diff.length ? `${t("sync.overwriteQuestion")}\n${diff.join("\n")}` : t("sync.question"),
          [
            { value: "apply", label: t("sync.overwrite"), hint: t("sync.overwriteHint", { n: diff.length }) },
            { value: "cancel", label: t("dialog.cancel") },
          ],
        );
        if (go !== "apply") return false;
      }

      store.replacePaletteSlots(proposed);
      toast(t("sync.done"), { kind: "info" });
      return true;
    },
  };
}
