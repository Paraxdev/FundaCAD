import { defineStore } from "pinia";
import { markRaw, ref } from "vue";
import { emptyFaceSet, newLoad, newSetup, type StressFaceSet, type StressResultView, type StressSetup } from "../ui/stress";

/** A key/value readout line. */
export interface PanelRow {
  k: string;
  v: string;
}

export interface PropertiesData {
  title: string;
  rows: PanelRow[];
  /** Unrounded mm/mm2/mm3 values, for the filament estimate to compute from
   *  live as the user changes material/infill, without a unit-display round
   *  trip through the formatted rows above. */
  raw: { volumeMm3: number; areaMm2: number };
}

/** One overlapping pair, keeping the body ids so clicking the row can select
 *  them. Volume is pre-formatted in display units by the facade, unit
 *  conversion stays next to the geometry that produced the number. */
export interface ClashRow extends PanelRow {
  a: string;
  b: string;
}

/** One near-miss pair from clearance mode, same shape as a ClashRow. */
export interface ClearanceRow extends PanelRow {
  a: string;
  b: string;
}

export interface InterferenceData {
  title: string;
  clashes: ClashRow[];
  clearances: ClearanceRow[];
  /** Set when the engine capped the candidate-pair sweep on a dense assembly. */
  truncatedMessage?: string;
}

/** The Stress panel: the setup the user edits in place, the request in flight
 *  (its id, for Cancel), and the last result, already in display units. */
export interface StressData {
  setup: StressSetup;
  /** True from Run until the reply; `requestId` arrives once it is sent. */
  running: boolean;
  requestId: string | null;
  result: StressResultView | null;
  /** Why the last Run did not produce a result, cleared by the next. */
  error: string | null;
  /** The result's colours: on the body in the view, taken off so the body's
   *  faces can be picked again (the rows stay), or none to show, before a Run
   *  or once the model has changed under them. */
  colours: "shown" | "hidden" | "none";
}

/** The floating "measure-panel" popups. Each is independent, Properties and
 *  the Overhang settings can legitimately be on screen together, which is why
 *  this is separate fields rather than one `activePanel` discriminant. */
export const usePanelsStore = defineStore("panels", () => {
  const properties = ref<PropertiesData | null>(null);
  const interference = ref<InterferenceData | null>(null);
  const overhang = ref(false);
  const params = ref(false);

  function showProperties(d: PropertiesData) {
    properties.value = markRaw(d);
  }
  function showInterference(d: InterferenceData) {
    interference.value = markRaw(d);
  }

  // Not markRaw: the panel's inputs write into `setup` directly.
  const stress = ref<StressData | null>(null);

  /** Open the Stress panel. A panel already open keeps its setup; `body` only
   *  seeds a fresh one or fills one that has none. */
  function showStress(body: string | null) {
    if (stress.value) {
      if (!stress.value.setup.body) stress.value.setup.body = body;
      return;
    }
    stress.value = { setup: newSetup(body), running: false, requestId: null, result: null, error: null, colours: "none" };
  }

  /** Change the analysed body. Faces belong to one body, so the face sets of
   *  another are dropped with it. */
  function setStressBody(body: string | null) {
    const s = stress.value?.setup;
    if (!s || s.body === body) return;
    s.body = body;
    s.fixed = emptyFaceSet();
    for (const l of s.loads) l.faces = emptyFaceSet();
  }

  function setStressFixed(faces: StressFaceSet) {
    if (stress.value) stress.value.setup.fixed = faces;
  }

  function setStressLoadFaces(loadId: number, faces: StressFaceSet) {
    const l = stress.value?.setup.loads.find((x) => x.id === loadId);
    if (l) l.faces = faces;
  }

  function addStressLoad() {
    const s = stress.value?.setup;
    if (!s) return;
    s.loads.push(newLoad(s.loads.reduce((m, l) => Math.max(m, l.id), 0) + 1));
  }

  function removeStressLoad(loadId: number) {
    const s = stress.value?.setup;
    if (s) s.loads = s.loads.filter((l) => l.id !== loadId);
  }

  function stressStarted() {
    if (!stress.value) return;
    stress.value.running = true;
    stress.value.requestId = null;
    stress.value.error = null;
  }

  function stressSent(id: string) {
    if (stress.value?.running) stress.value.requestId = id;
  }

  /** Settle a Run: a result, an error, or neither for a cancel. */
  function stressFinished(outcome: { result?: StressResultView; error?: string }) {
    if (!stress.value) return;
    stress.value.running = false;
    stress.value.requestId = null;
    if (outcome.result) stress.value.result = markRaw(outcome.result);
    stress.value.error = outcome.error ?? null;
  }

  function clearStressResult() {
    if (!stress.value) return;
    stress.value.result = null;
    stress.value.colours = "none";
  }

  function setStressColours(c: StressData["colours"]) {
    if (stress.value) stress.value.colours = c;
  }

  return {
    properties, interference, overhang, params, stress,
    showProperties, showInterference,
    showStress, setStressBody, setStressFixed, setStressLoadFaces, addStressLoad, removeStressLoad,
    stressStarted, stressSent, stressFinished, clearStressResult, setStressColours,
  };
});
