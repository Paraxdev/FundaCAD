import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";

/** The live print-progress pill. Deliberately separate from the geometry status
 *  line (stores/ui.ts) so printer progress can never clobber build/connection
 *  state — the two used to be different DOM nodes for exactly that reason. */
export const usePrintStatusStore = defineStore("printStatus", () => {
  const text = ref<string | null>(null);
  // shallowRef + a plain function: this is a callback into the engine (it opens
  // the camera panel), not data.
  const onClick = shallowRef<(() => void) | null>(null);
  return { text, onClick };
});
