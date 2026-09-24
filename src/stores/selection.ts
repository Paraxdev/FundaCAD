import { defineStore } from "pinia";
import { ref } from "vue";

/** The selected timeline/browser feature id.
 *
 *  This was a module-level `let selectedFeature` in main.ts, pushed imperatively
 *  into three panels by selectFeature(). It has to be reactive now because the
 *  inspector renders from it; the engine keeps `engine.selectedFeature` working
 *  as an accessor over this, so the ~10 non-Vue readers are unchanged.
 *
 *  Note this is FEATURE selection only. Face/edge/body selection still lives in
 *  the Viewport, which is why the browser tree pulls it through predicates at
 *  render time rather than being handed it. */
export const useSelectionStore = defineStore("selection", () => {
  const featureId = ref<string | null>(null);
  // True when featureId was set by the user picking it (a click, a tree row, an
  // active edit); false when the engine set it on its own, such as auto-selecting
  // a just-committed sketch's profile for extrude. Delete reads this so a
  // keystroke never removes a feature the user never actually chose.
  const featureExplicit = ref(true);
  return { featureId, featureExplicit };
});
