import { defineStore } from "pinia";
import { markRaw, shallowRef } from "vue";
import type { BodyScope, ExportSettings } from "../io/exportSettings";
import type { ExportFormat } from "../types";

export interface ExportChoice {
  settings: ExportSettings;
  scope: BodyScope;
}

interface ExportOpen {
  bodies: { id: string; name: string }[];
  /** Where the body picker starts. */
  scope?: BodyScope;
  /** The bodies "selected" exports, more than one to offer it. */
  selected?: readonly string[];
  /** What a DXF or SVG export would draw; without one those formats are not offered. */
  flat?: { label: string };
  /** The format the dialog starts on instead of the remembered one. */
  format?: ExportFormat;
}

interface ExportRequest extends ExportOpen {
  resolve: (choice: ExportChoice | null) => void;
}

/** The Export dialog's one open request, null while it is closed. */
export const useExportDialogStore = defineStore("exportDialog", () => {
  const request = shallowRef<ExportRequest | null>(null);

  function open(what: ExportOpen): Promise<ExportChoice | null> {
    request.value?.resolve(null);
    return new Promise((resolve) => {
      request.value = markRaw({ ...what, resolve });
    });
  }

  function finish(choice: ExportChoice | null) {
    const r = request.value;
    request.value = null;
    r?.resolve(choice);
  }

  return { request, open, finish };
});
