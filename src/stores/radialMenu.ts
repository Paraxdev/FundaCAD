import { defineStore } from "pinia";
import { markRaw, shallowRef } from "vue";
import type { RadialState } from "../ui/radialMenu";

/** The open radial menu, drawn by components/overlays/RadialMenuHost.vue. */
export const useRadialMenuStore = defineStore("radialMenu", () => {
  const state = shallowRef<RadialState | null>(null);
  function set(s: RadialState | null) {
    state.value = s ? markRaw(s) : null;
  }
  return { state, set };
});
