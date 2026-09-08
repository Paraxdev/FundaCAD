import { defineStore } from "pinia";
import { markRaw, ref } from "vue";

/** A key/value readout line. */
export interface PanelRow {
  k: string;
  v: string;
}

export interface PropertiesData {
  title: string;
  rows: PanelRow[];
}

/** One overlapping pair, keeping the body ids so clicking the row can select
 *  them. Volume is pre-formatted in display units by the facade — unit
 *  conversion stays next to the geometry that produced the number. */
export interface ClashRow extends PanelRow {
  a: string;
  b: string;
}

export interface InterferenceData {
  title: string;
  clashes: ClashRow[];
}

/** The floating "measure-panel" popups. Each is independent — Properties and
 *  the Overhang settings can legitimately be on screen together, which is why
 *  this is four fields rather than one `activePanel` discriminant. */
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

  return { properties, interference, overhang, params, showProperties, showInterference };
});
