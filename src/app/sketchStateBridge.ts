import { setPrompt } from "../ui/prompt";
import { endPickSession } from "../ui/treePick";
import { setWorkspace } from "../ui/workspace";
import { SELF_PROMPTING, SKETCH_PROMPTS } from "./actionTables";
import { useUiStore } from "../stores/ui";
import { useSketchPaletteStore } from "../stores/sketchPalette";
import { useRibbonStore } from "../stores/ribbon";
import type { Engine } from "./engine";

export function installSketchStateBridge(e: Engine): void {
  const ui = useUiStore();
  const palette = useSketchPaletteStore();
  const ribbon = useRibbonStore();

  // Selected on exit so extrude has a profile ready, but not as a user pick, which Delete would act on.
  e.sketch.onCommitted = (id) => e.selectFeature(id, false);
  e.sketch.onViewSquare = (square) => {
    palette.offNormal = !square;
  };

  let sketchWasActive = false;
  e.sketch.onState = () => {
    if (e.sketch.active !== sketchWasActive) endPickSession();
    if (e.sketch.active && !sketchWasActive) {
      palette.emitAll();
      // The Render column would cover 300px of the plane; it stays off after Finish Sketch on purpose.
      setWorkspace("model");
    }
    sketchWasActive = e.sketch.active;
    ribbon.context = e.sketch.active ? "sketch" : "model";
    ribbon.activeSketchTool = e.sketch.tool;
    ribbon.sketchId = e.sketch.active ? e.sketch.editingSketchId : null;
    palette.visible = e.sketch.active;
    ui.sketchActive = e.sketch.active;
    if (e.sketch.active) {
      if (!SELF_PROMPTING.has(e.sketch.tool)) setPrompt(SKETCH_PROMPTS[e.sketch.tool] ?? null);
    } else {
      setPrompt(null);
    }
  };

  // The component and emitAll() on sketch entry both land here.
  palette.bind({
    onToggle: (key, value) => {
      switch (key) {
        case "lockView":
          e.sketch.setViewLocked(value);
          break;
        case "construction":
          e.sketch.setConstruction(value);
          break;
        case "reference":
          e.sketch.setReferenceDim(value);
          break;
        case "grid":
          e.sketch.setGridVisible(value);
          break;
        case "snap":
          e.sketch.setGridSnap(value);
          break;
        case "profile":
          e.overlay.setFillsVisible(value);
          break;
        case "dimensions":
          e.sketch.setDimensionsVisible(value);
          break;
        case "constraints":
          e.sketch.setConstraintsVisible(value);
          break;
      }
    },
    onLookAt: () => e.sketch.lookAt(),
  });
}
