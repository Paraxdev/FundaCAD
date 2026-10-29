import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import { EMPTY_SELECTION, type RowSelection } from "../ui/rowSelection";

/** The selected timeline/browser feature id, with `engine.selectedFeature` as an accessor over it. Feature selection
 *  only: face, edge and body selection live in the Viewport. */
export const useSelectionStore = defineStore("selection", () => {
  const featureId = ref<string | null>(null);
  // False when the engine set it itself, like a just-committed sketch's profile for extrude, so Delete never removes a
  // feature the user did not choose.
  const featureExplicit = ref(true);
  /** Every row picked in History and the Items lists, `featureId` being the one the inspector follows. Origin planes
   *  are in it as "o:XY". Always set through Engine.selectFeatureRows, which keeps the viewport in step. */
  const rows = shallowRef<RowSelection<string>>(EMPTY_SELECTION);
  return { featureId, featureExplicit, rows };
});

/** Origin plane rows are picked as "o:XY", they are not features. */
export const isOriginKey = (k: string) => k.startsWith("o:");

/** How many features the picked rows hold: origin planes and ids the document lost since do not count. */
export function pickedFeatureCount(rows: RowSelection<string>, features: readonly { id: string }[]): number {
  const have = new Set(features.map((f) => f.id));
  return rows.keys.filter((k) => !isOriginKey(k) && have.has(k)).length;
}
