import { defineStore } from "pinia";
import { markRaw, shallowRef } from "vue";
import type { BodyScope, ExportSettings } from "../io/exportSettings";

export interface ExportChoice {
  settings: ExportSettings;
  scope: BodyScope;
}

interface ExportRequest {
  bodies: { id: string; name: string }[];
  resolve: (choice: ExportChoice | null) => void;
}

/** The Export dialog's one open request, null while it is closed. */
export const useExportDialogStore = defineStore("exportDialog", () => {
  const request = shallowRef<ExportRequest | null>(null);

  function open(bodies: { id: string; name: string }[]): Promise<ExportChoice | null> {
    request.value?.resolve(null);
    return new Promise((resolve) => {
      request.value = markRaw({ bodies, resolve });
    });
  }

  function finish(choice: ExportChoice | null) {
    const r = request.value;
    request.value = null;
    r?.resolve(choice);
  }

  return { request, open, finish };
});
