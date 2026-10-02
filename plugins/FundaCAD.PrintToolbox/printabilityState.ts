// The Printability panel's state, owned by this plugin rather than by the
// app's panels store: the settings the user edits in place, the check in
// flight (its id, for Cancel), and the last result grouped by body. One per
// activation, so switching the plugin off and on starts it fresh.

import { markRaw, ref } from "vue";
import { newPrintabilitySetup, type PrintabilitySetup, type PrintabilityView } from "./printability";

export interface PrintabilityData {
  setup: PrintabilitySetup;
  /** True from Check until the reply; `requestId` arrives once it is sent. */
  running: boolean;
  requestId: string | null;
  result: PrintabilityView | null;
  /** Why the last Check did not produce a result, cleared by the next. */
  error: string | null;
  /** The model changed since the result: its rows stay, but their faces may
   *  be other faces now, so nothing is tinted until the next Check. */
  stale: boolean;
  /** The finding under the pointer in the list, and the one last clicked, by
   *  index into `result.findings`. The hovered one wins while there is one. */
  hovered: number | null;
  picked: number | null;
}

export function createPrintabilityState() {
  // Not markRaw: the settings are bound to the panel's inputs.
  const data = ref<PrintabilityData | null>(null);

  /** Open the panel. A panel already open keeps its settings. */
  function show() {
    if (data.value) return;
    data.value = {
      setup: newPrintabilitySetup(), running: false, requestId: null, result: null, error: null, stale: false,
      hovered: null, picked: null,
    };
  }

  function close() {
    data.value = null;
  }

  function started() {
    if (!data.value) return;
    data.value.running = true;
    data.value.requestId = null;
    data.value.error = null;
  }

  function sent(id: string) {
    if (data.value?.running) data.value.requestId = id;
  }

  /** Settle a Check: a result, an error, or neither for a cancel. A new result
   *  starts with nothing put forward. */
  function finished(outcome: { result?: PrintabilityView; error?: string }) {
    const d = data.value;
    if (!d) return;
    d.running = false;
    d.requestId = null;
    if (outcome.result) {
      d.result = markRaw(outcome.result);
      d.stale = false;
      d.hovered = null;
      d.picked = null;
    }
    d.error = outcome.error ?? null;
  }

  function clearResult() {
    const d = data.value;
    if (!d) return;
    d.result = null;
    d.stale = false;
    d.hovered = null;
    d.picked = null;
  }

  function setStale() {
    if (data.value?.result) data.value.stale = true;
  }

  function setFocus(which: "hovered" | "picked", index: number | null) {
    if (data.value) data.value[which] = index;
  }

  return { data, show, close, started, sent, finished, clearResult, setStale, setFocus };
}

export type PrintabilityState = ReturnType<typeof createPrintabilityState>;
