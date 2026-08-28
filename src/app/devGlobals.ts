import { nextTick } from "vue";
import { solveSketch } from "../sketch/solver";
import { isChoiceOpen, choose } from "../ui/choice";
import { toast } from "../ui/toast";
import { contextMenu, dismissContextMenu } from "../ui/menu";
import { useBrowserStore } from "../stores/browser";
import type { Engine } from "./engine";

/** Debug handles for console + headless frontend-logic tests. Gated to DEV so
 *  they're absent from production bundles — a post-XSS attacker shouldn't be
 *  handed the live store/geometry API for free (the vite dev server is DEV, so
 *  the localhost:5173 test workflow keeps them).
 *
 *  The e2e scripts in e2e/*.cjs drive the app entirely through these, so the
 *  names here are a contract: `store`, `tree`, `viewport` and `geometry` are all
 *  waited on by `page.waitForFunction` before any test step runs. */
export function installDevGlobals(e: Engine): void {
  if (!import.meta.env.DEV) return;
  const w = window as any;
  w.viewport = e.viewport;
  w.store = e.store;
  w.geometry = e.geometry;
  w.sketch = e.sketch;
  w.overlay = e.overlay;
  w.extrude = e.tools.extrude;
  w.edgeFeature = e.tools.edgeFeature;
  w.pressPull = e.tools.pressPull;
  w.textureTool = e.tools.texture;
  w.solveSketch = solveSketch;
  // The browser tree is components/shell/BrowserPane.vue now, so this is a
  // handle onto its store rather than onto a class. refresh() is ASYNC: "render
  // this now" in Vue is nextTick, and the bump is what makes it a genuine
  // re-render rather than a no-op — e2e/browser_tree_perf.cjs times exactly this
  // call and would otherwise measure nothing and report a false speedup.
  w.tree = {
    refresh: async () => {
      useBrowserStore().bumpView();
      await nextTick();
    },
    beginRename: (id: string) => useBrowserStore().beginRename(id),
  };
  // DEV-only handle for driving the app from outside (demo capture, e2e).
  w.__neocad = {
    store: e.store,
    viewport: e.viewport,
    sketch: e.sketch,
    handleAction: (a: string) => e.handleAction(a),
    // Which feature the panels are showing. A harness that wants to open a
    // feature's Properties has to say WHICH, and the timeline chip that normally
    // does it is a click on a scrolling strip.
    selectFeature: (id: string | null) => e.selectFeature(id),
    extrude: e.tools.extrude,
    move: e.tools.move,
    targetEdit: e.tools.targetEdit,
    pattern: e.tools.pattern,
    overlay: e.overlay,
    toolBusy: () => e.toolBusy(),
    // The one formula every datum surface goes through: the drawn quad, "sketch
    // on this plane", and an offset plane's target. Exposed so a harness can ask
    // where a datum IS without reading it back out of the scene graph, which is
    // the only way to see that a datum following a face followed it on screen
    // too and not just in the kernel.
    datumPlaneDef: (f: Parameters<Engine["datumPlaneDef"]>[0]) => e.datumPlaneDef(f),
    // Direct handles on the two global overlay facades, so a harness can drive
    // them without needing an operation that happens to raise one.
    toast,
    choose,
    menu: { contextMenu, dismissContextMenu },
    busyWhy: () => ({
      sketch: e.sketch.active,
      extrude: e.tools.extrude.active,
      edgeFeature: e.tools.edgeFeature.active,
      pressPull: e.tools.pressPull.active,
      faceOffset: e.tools.faceOffset.active,
      loft: e.tools.loft.active,
      planeOffset: e.tools.planeOffset.active,
      move: e.tools.move.active,
      pattern: e.tools.pattern.active,
      measure: e.tools.measure.active,
      section: e.tools.section.active,
      texture: e.tools.texture.active,
      targetEdit: e.tools.targetEdit.active,
      planePick: e.planePick,
      choice: isChoiceOpen(),
    }),
  };
}
