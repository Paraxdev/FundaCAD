// Facade over ./printStatus.ts, rendered by ./PrintStatusPill.vue. Pass null to hide.
import { usePrintStatusStore } from "./printStatus";

export function setPrinterStatusText(text: string | null) {
  usePrintStatusStore().text = text;
}

/** Make the pill clickable, or `null` to take that away again, which turning the printer capability off has to do
 *  rather than leave a closure over an engine it no longer belongs to. */
export function setPrinterPillClick(fn: (() => void) | null) {
  usePrintStatusStore().onClick = fn;
}
