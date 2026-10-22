import { nextTick } from "vue";
import { solveSketch } from "../sketch/solver";
import { isChoiceOpen, choose } from "../ui/choice";
import { toast } from "../ui/toast";
import { contextMenu, dismissContextMenu } from "../ui/menu";
import { useBrowserStore } from "../stores/browser";
import { renderPrefs, setRenderPref } from "../ui/renderPrefs";
import type { Engine } from "./engine";
import { setLibrary } from "../io/library";
import { fakeLibrary, type FakeFile, type FakeLibrary } from "../io/fakeLibrary";
import { contribute } from "../plugins/contrib";

/** DEV only, so an XSS in production is not handed the live store. The names are a contract with the old e2e/*.cjs
 *  scripts, which wait on `store`, `tree`, `viewport` and `geometry`; new scripts use src/harness. */
export function installDevGlobals(e: Engine): void {
  if (!import.meta.env.DEV) return;
  const w = window as any;
  let fake: FakeLibrary | null = null;
  w.viewport = e.viewport;
  w.store = e.store;
  w.geometry = e.geometry;
  w.sketch = e.sketch;
  w.overlay = e.overlay;
  w.extrude = e.tools.extrude;
  w.edgeFeature = e.tools.edgeFeature;
  w.pressPull = e.tools.pressPull;
  w.section = e.tools.section;
  w.solveSketch = solveSketch;
  // The bump forces a real re-render, which e2e/browser_tree_perf.cjs times; without it the test measures nothing.
  w.tree = {
    refresh: async () => {
      useBrowserStore().bumpView();
      await nextTick();
    },
    beginRename: (id: string) => useBrowserStore().beginRename(id),
  };
  w.__fundacad = {
    store: e.store,
    viewport: e.viewport,
    setRealtimeQuality: (q: "standard" | "high") => setRenderPref("realtimeQuality", q),
    sketch: e.sketch,
    handleAction: (a: string) => e.handleAction(a),
    // Home reads the library when it opens, so reopen it after this.
    home: {
      useFakeLibrary: (files: FakeFile[], picks?: string[]) => {
        fake = fakeLibrary(files, picks);
        setLibrary(fake);
      },
      thumbRequests: () => [...(fake?.thumbRequests ?? [])],
    },
    // The app's own module instance: a harness importing /src/ui/renderPrefs.ts
    // after an HMR update gets a second copy whose listeners reach nothing.
    renderPrefs,
    setRenderPref,
    // Contribute as a plugin would, for a capability no plugin offers yet.
    contribute,
    selectFeature: (id: string | null) => e.selectFeature(id),
    selectedFeature: () => e.selectedFeature,
    // Selecting opens a feature's values, editing opens its manipulator.
    editFeature: (id: string) => e.editFeature(id),
    extrude: e.tools.extrude,
    move: e.tools.move,
    datumPose: e.tools.datumPose,
    lightAim: e.tools.lightAim,
    targetEdit: e.tools.targetEdit,
    pattern: e.tools.pattern,
    revolvePitch: e.tools.revolvePitch,
    draft: e.tools.draft,
    thread: e.tools.thread,
    textOnFace: e.tools.textOnFace,
    hole: e.tools.hole,
    overlay: e.overlay,
    nudge: e.nudge,
    faceOffset: e.tools.faceOffset,
    toolBusy: () => e.toolBusy(),
    datumPlaneDef: (f: Parameters<Engine["datumPlaneDef"]>[0]) => e.datumPlaneDef(f),
    // Lets a harness write a mark onto the build result and prove the datum is drawn there.
    syncDatumPlanes: () => e.syncDatumPlanes(),
    toast,
    choose,
    menu: { contextMenu, dismissContextMenu },
    busyWhy: () => ({
      sketch: e.sketch.active,
      extrude: e.tools.extrude.active,
      edgeFeature: e.tools.edgeFeature.active,
      pressPull: e.tools.pressPull.active,
      faceOffset: e.tools.faceOffset.active,
      draft: e.tools.draft.active,
      thread: e.tools.thread.active,
      textOnFace: e.tools.textOnFace.active,
      hole: e.tools.hole.active,
      loft: e.tools.loft.active,
      planeOffset: e.tools.planeOffset.active,
      datumPose: e.tools.datumPose.active,
      move: e.tools.move.active,
      pattern: e.tools.pattern.active,
      measure: e.tools.measure.active,
      section: e.tools.section.picking,
      targetEdit: e.tools.targetEdit.active,
      revolvePitch: e.tools.revolvePitch.active,
      planePick: e.planePick,
      choice: isChoiceOpen(),
    }),
  };
}
