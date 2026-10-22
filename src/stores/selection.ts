import { defineStore } from "pinia";
import { ref } from "vue";

/** The selected timeline/browser feature id, with `engine.selectedFeature` as an accessor over it. Feature selection
 *  only: face, edge and body selection live in the Viewport. */
export const useSelectionStore = defineStore("selection", () => {
  const featureId = ref<string | null>(null);
  // False when the engine set it itself, like a just-committed sketch's profile for extrude, so Delete never removes a
  // feature the user did not choose.
  const featureExplicit = ref(true);
  return { featureId, featureExplicit };
});
