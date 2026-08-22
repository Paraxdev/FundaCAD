import { isChoiceOpen } from "../ui/choice";
import type { Engine } from "./engine";

/** Guard predicates checked at the top of every start* tool and interactive helper:
 *  they can't fire mid-sketch / mid-drag.
 *
 *  Plain functions rather than reactive state, deliberately. `toolBusy` is only read
 *  at event time and nothing in the UI is disabled by it, so making it reactive
 *  would mean polling eleven `.active` fields every frame or bolting
 *  change-notification onto ten tool classes for no present gain.
 *
 *  Cross-section is the one entry that is NOT `.active`. It became a MODE you keep
 *  working inside, so counting it as busy made every command in the app return
 *  silently for as long as the section was up — the same invisible dead-app symptom
 *  the stale `planePick` flag used to cause. Its modal half, `picking`, genuinely
 *  does own the gesture. The section stands its own handle down while another tool
 *  runs by reading this predicate back. */
export function createToolBusy(e: Engine): Pick<Engine, "toolBusy" | "hasBody"> {
  return {
    toolBusy: () => {
      const t = e.tools;
      return (
        e.sketch.active || t.extrude.active || t.edgeFeature.active || t.pressPull.active ||
        t.faceOffset.active || t.loft.active || t.planeOffset.active || t.move.active || t.pattern.active ||
        t.measure.active || t.section.picking || t.texture.active || t.targetEdit.active ||
        e.planePick || isChoiceOpen()
      );
    },
    // True when the current rebuild produced a solid body (something to modify).
    hasBody: () => (e.store.buildState.result?.mesh.positions.length ?? 0) > 0,
  };
}
