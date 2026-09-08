// This capability's own windows: which printer's camera is open, and the
// filament-mapping question waiting for an answer.
//
// Both used to be fields on the app's stores. `panels.camera` sat beside
// "which bodies are overlapping" and "what are this body's properties" in
// stores/panels.ts, and `dialogs.filament` sat in stores/dialogs.ts holding a
// request typed against this directory's printer client, which dragged two type
// imports across the boundary into every module that touches a dialog. Neither
// was ever anything but this capability's, and the app is not the right place to
// keep one piece of state per capability that might want a window.
//
// Plain refs rather than a Pinia store: nothing outside this directory reads
// them, and a module-level ref works in the headless suite without a Pinia
// instance to install first.

import { markRaw, ref, shallowRef } from "vue";
import type { LogicalSlot, MappingResult } from "./printDialog";
import type { ToolheadFilament } from "./printerClient";

/** The printer whose camera is open, or null when it is closed. */
export const cameraPanel = ref<string | null>(null);

export function showCamera(printerId: string) {
  cameraPanel.value = printerId;
}

/** One filament-mapping question: the slots the job uses, the toolheads the
 *  machine has, and the answer it is waiting for. */
export interface FilamentReq {
  slots: LogicalSlot[];
  toolheads: ToolheadFilament[];
  resolve: (result: MappingResult | null) => void;
}

export const filamentReq = shallowRef<FilamentReq | null>(null);

/** Ask, and resolve when the dialog closes. `null` is "cancelled", which the
 *  send flow treats as "do not print" rather than as a failure.
 *
 *  markRaw because the request holds a `resolve` closure, which must not become
 *  a Proxy, the same rule the app's dialog store follows for the same reason. */
export function openFilamentMapping(
  slots: LogicalSlot[],
  toolheads: ToolheadFilament[],
): Promise<MappingResult | null> {
  return new Promise<MappingResult | null>((resolve) => {
    filamentReq.value = markRaw<FilamentReq>({
      slots,
      toolheads,
      resolve: (result) => {
        filamentReq.value = null;
        resolve(result);
      },
    });
  });
}
