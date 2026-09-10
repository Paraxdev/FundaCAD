import { setPrompt } from "../ui/prompt";
import { setWorkspace } from "../ui/workspace";
import { SKETCH_PROMPTS } from "./actionTables";
import { useUiStore } from "../stores/ui";
import { useSketchPaletteStore } from "../stores/sketchPalette";
import { useRibbonStore } from "../stores/ribbon";
import type { Engine } from "./engine";

/** Sketch mode state -> UI (ribbon context, palette, prompt, context tab), and
 *  the palette's toggles back into the sketch/overlay. */
export function installSketchStateBridge(e: Engine): void {
  const ui = useUiStore();
  const palette = useSketchPaletteStore();
  const ribbon = useRibbonStore();

  let sketchWasActive = false;
  e.sketch.onState = () => {
    if (e.sketch.active && !sketchWasActive) {
      palette.emitAll(); // apply palette opts
      // Out of the Render workspace, whichever one was up. A sketch is a mode
      // with its own ribbon, its own escape and its own view lock, and drawing
      // it with a materials column taking 300px of the plane being drawn on
      // helps nobody. It does not come back on Finish Sketch, deliberately: what
      // you do after finishing a sketch is look at the solid it made.
      setWorkspace("model");
    }
    sketchWasActive = e.sketch.active;
    ribbon.context = e.sketch.active ? "sketch" : "model";
    ribbon.activeSketchTool = e.sketch.tool;
    palette.visible = e.sketch.active;
    // #context-tab is components/shell/TitleBar.vue now, SOLID/SKETCH and the
    // .sketch class both derive from this one flag.
    ui.sketchActive = e.sketch.active;
    if (e.sketch.active) {
      setPrompt(SKETCH_PROMPTS[e.sketch.tool] ?? null);
    } else {
      setPrompt(null);
    }
  };

  // --- sketch palette toggles -> sketch/overlay ---
  // The component fires these through the store, and so does emitAll() on
  // sketch entry, so both paths land on one switch exactly as before.
  palette.bind({
    onToggle: (key, value) => {
      switch (key) {
        case "lockView": e.sketch.setViewLocked(value); break;
        case "construction": e.sketch.setConstruction(value); break;
        case "reference": e.sketch.setReferenceDim(value); break;
        case "grid": e.sketch.setGridVisible(value); break;
        case "snap": e.sketch.setGridSnap(value); break;
        case "profile": e.overlay.setFillsVisible(value); break;
        case "dimensions": e.sketch.setDimensionsVisible(value); break;
        case "constraints": e.sketch.setConstraintsVisible(value); break;
      }
    },
    onLookAt: () => e.sketch.lookAt(),
  });
}
