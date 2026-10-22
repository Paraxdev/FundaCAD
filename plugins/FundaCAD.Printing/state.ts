// Plain refs rather than a Pinia store: nothing outside this directory reads them, and a module ref works in the
// headless suite without a Pinia instance to install first.

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

/** Ask, and resolve when the dialog closes; `null` is "cancelled", which the send flow treats as "do not print".
 *  markRaw because the request holds a `resolve` closure that must not become a Proxy, as in the app dialog store. */
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
