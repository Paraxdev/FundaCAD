// The custom bed size dialog's own window, mirroring FundaCAD.Printing's
// filament-mapping request: a plain ref outside any store, so a mounted
// dialog IS the question being open, and closing it is answering.

import { markRaw, shallowRef } from "vue";
import type { Vec3 } from "./bedFit";

export interface CustomBedRequest {
  initial: Vec3;
  resolve: (size: Vec3 | null) => void;
}

export const customBedReq = shallowRef<CustomBedRequest | null>(null);

/** Ask for a custom bed size, prefilled from `initial`. Resolves null on Cancel/Esc. */
export function openCustomBedDialog(initial: Vec3): Promise<Vec3 | null> {
  return new Promise<Vec3 | null>((resolve) => {
    customBedReq.value = markRaw<CustomBedRequest>({
      initial,
      resolve: (size) => {
        customBedReq.value = null;
        resolve(size);
      },
    });
  });
}
