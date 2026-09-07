// A small self-managed status pill for live print progress, shown above the
// toast stack. Kept separate from the geometry status line (stores/ui.ts) so
// printer progress never clobbers build/connection state. Pass null to hide.
//
// Facade over stores/printStatus.ts, rendered by
// components/overlays/PrintStatusPill.vue. Both exported signatures are
// unchanged.
import { usePrintStatusStore } from "../stores/printStatus";

export function setPrinterStatusText(text: string | null) {
  usePrintStatusStore().text = text;
}

/** Make the pill clickable (e.g. open the camera panel), or `null` to take the
 *  behaviour away again — which is what turning the printer capability off has
 *  to do, rather than leave a closure over an engine it no longer belongs to. */
export function setPrinterPillClick(fn: (() => void) | null) {
  usePrintStatusStore().onClick = fn;
}
