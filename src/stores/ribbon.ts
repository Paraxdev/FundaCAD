import { defineStore } from "pinia";
import { ref } from "vue";
import type { RibbonContext } from "../ui/ribbonDefs";

/** Both pushed in by app/sketchStateBridge.ts from SketchMode's onState: the ribbon reflects sketch state, never owns
 *  it. */
export const useRibbonStore = defineStore("ribbon", () => {
  const context = ref<RibbonContext>("model");
  /** The armed sketch tool, highlighted on its button. Empty when none. */
  const activeSketchTool = ref("");
  /** The sketch feature being edited, null for a sketch not yet committed. */
  const sketchId = ref<string | null>(null);

  /** The viewport's analysis toggles, pushed in by app/viewportWiring.ts since the viewport is not reactive. */
  const viewOn = ref<Record<string, boolean>>({});

  let run: ((action: string) => void) | null = null;
  function bind(fn: (action: string) => void) {
    run = fn;
  }
  function act(action: string) {
    run?.(action);
  }

  let keyArmed: (() => void) | null = null;
  function bindKeyArmed(fn: () => void) {
    keyArmed = fn;
  }
  /** A tool button was pressed from the keyboard: the sketch moves focus to where its keys are heard. */
  function actedByKeys() {
    keyArmed?.();
  }

  return { context, activeSketchTool, sketchId, viewOn, bind, act, bindKeyArmed, actedByKeys };
});
