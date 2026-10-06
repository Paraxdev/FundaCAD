import { defineStore } from "pinia";
import { markRaw, ref } from "vue";
import {
  emptyFaceSet, newLoad, newSetup, newSupport, nextId,
  type StressFaceSet, type StressResultView, type StressSetup, type StressTarget,
} from "../ui/stress";
import type { StressSpot, StressSupportType, Vec3 } from "../types";

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

/** The deformed shape drawn on the result's colours: the scale on the slider,
 *  the automatic one it started at, the slider's top, and whether it swings. */
export interface StressDeform {
  scale: number;
  auto: number;
  max: number;
  animate: boolean;
}

/** A point pinned on the coloured body: where it is on the result's surface
 *  (a triangle and barycentric weights, so it rides the deformed shape) and the
 *  readout taken there. */
export interface StressProbePin {
  id: number;
  tri: number;
  weights: Vec3;
  label: string;
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
  /** Null until a result with displacements arrives. */
  deform: StressDeform | null;
  /** Probe mode, and the points pinned with it. */
  probe: boolean;
  pins: StressProbePin[];
  /** The row whose next click on the body places a spot, null when none is. */
  placing: StressTarget | null;
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
    stress.value = fresh(newSetup(body));
  }

  function fresh(setup: StressSetup): StressData {
    return {
      setup, running: false, requestId: null, result: null, error: null, colours: "none",
      deform: null, probe: false, pins: [], placing: null,
    };
  }

  /** Put a setup in place of the panel's, as a saved study is read back. Drops
   *  the result, which was for the setup it replaces. */
  function replaceStressSetup(setup: StressSetup) {
    if (stress.value) {
      stress.value.setup = setup;
      clearStressResult();
    } else {
      stress.value = fresh(setup);
    }
  }

  /** Change the analysed body. Faces belong to one body, so the face sets of
   *  another are dropped with it. */
  function setStressBody(body: string | null) {
    const s = stress.value?.setup;
    if (!s || s.body === body) return;
    s.body = body;
    for (const x of [...s.supports, ...s.loads]) {
      x.faces = emptyFaceSet();
      delete x.spots;
    }
  }

  function stressRow(target: StressTarget) {
    const s = stress.value?.setup;
    if (!s) return undefined;
    return "support" in target ? s.supports.find((x) => x.id === target.support) : s.loads.find((l) => l.id === target.load);
  }

  function addStressSpot(target: StressTarget, spot: StressSpot) {
    const row = stressRow(target);
    if (row) row.spots = [...(row.spots ?? []), spot];
  }

  function removeStressSpot(target: StressTarget, index: number) {
    const row = stressRow(target);
    if (!row?.spots) return;
    const left = row.spots.filter((_, i) => i !== index);
    if (left.length) row.spots = left;
    else delete row.spots;
  }

  function setStressPlacing(target: StressTarget | null) {
    if (stress.value) stress.value.placing = target;
  }

  function setStressSupportFaces(supportId: number, faces: StressFaceSet) {
    const x = stress.value?.setup.supports.find((v) => v.id === supportId);
    if (x) x.faces = faces;
  }

  function addStressSupport(type: StressSupportType = "fixed") {
    const s = stress.value?.setup;
    if (s) s.supports.push(newSupport(nextId(s.supports), type));
  }

  function removeStressSupport(supportId: number) {
    const s = stress.value?.setup;
    if (s) s.supports = s.supports.filter((x) => x.id !== supportId);
  }

  function setStressLoadFaces(loadId: number, faces: StressFaceSet) {
    const l = stress.value?.setup.loads.find((x) => x.id === loadId);
    if (l) l.faces = faces;
  }

  function addStressLoad() {
    const s = stress.value?.setup;
    if (!s) return;
    s.loads.push(newLoad(nextId(s.loads)));
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

  /** Drop the result and everything drawn from it: the deformed shape and
   *  the probes. */
  function clearStressResult() {
    if (!stress.value) return;
    stress.value.result = null;
    stress.value.colours = "none";
    stress.value.deform = null;
    stress.value.probe = false;
    stress.value.pins = [];
  }

  function setStressColours(c: StressData["colours"]) {
    if (stress.value) stress.value.colours = c;
  }

  function setStressDeform(d: StressDeform | null) {
    if (stress.value) stress.value.deform = d;
  }

  function setStressProbe(on: boolean) {
    if (stress.value) stress.value.probe = on;
  }

  function addStressPin(pin: Omit<StressProbePin, "id">) {
    const d = stress.value;
    if (d) d.pins.push({ ...pin, id: nextId(d.pins) });
  }

  function removeStressPin(id: number) {
    const d = stress.value;
    if (d) d.pins = d.pins.filter((p) => p.id !== id);
  }

  return {
    properties, interference, overhang, params, stress,
    showProperties, showInterference,
    showStress, replaceStressSetup, setStressBody, setStressSupportFaces, addStressSupport, removeStressSupport,
    setStressLoadFaces, addStressLoad, removeStressLoad, stressRow, addStressSpot, removeStressSpot, setStressPlacing,
    stressStarted, stressSent, stressFinished, clearStressResult, setStressColours,
    setStressDeform, setStressProbe, addStressPin, removeStressPin,
  };
});
