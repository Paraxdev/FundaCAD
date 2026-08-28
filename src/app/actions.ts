import { saveDocument, saveDocumentAs, exportModel, exportPrintProject, importModel } from "../io/files";
import { openInOrca, sendToPrinter } from "../print/printFlow";
import { openParamsDialog } from "../ui/paramsDialog";
import { toggleShortcutHUD } from "../input/shortcuts";
import { choose } from "../ui/choice";
import { SKETCH_TOOLS, SKETCH_MODIFY, NON_REPEATABLE } from "./actionTables";
import { booleanOpOfAction } from "../features/booleanOps";
import { useUiStore } from "../stores/ui";
import { useSketchPaletteStore } from "../stores/sketchPalette";
import type { Engine } from "./engine";
import type { SketchTool } from "../sketch/sketchMode";
import type { StandardView } from "../viewport/cameras";

/** The single dispatch point shared by the ribbon, the keymap, the command
 *  palette and every context menu. */
export function createActions(e: Engine): (action: string) => void {
  // The "persp" and "selmode" cases used to write projBtn.textContent and
  // selBtn.textContent/classList directly. Those two buttons are
  // components/shell/ViewControls.vue now and render from this store, so the
  // label can no longer drift out of sync with viewport.selecting.
  const ui = useUiStore();
  const palette = useSketchPaletteStore();

  // Offset Face / Thicken: one interactive tool for both (pick face → scrub along
  // its normal → commit), with a real sidecar preview since neither can be faked
  // client-side.
  function startFaceOffset(mode: "offsetFace" | "thicken") {
    if (e.toolBusy()) return;
    if (!e.hasBody()) {
      e.setStatus("Create or import a body first", "");
      return;
    }
    e.tools.faceOffset.start(mode, (id) => { if (id) e.selectFeature(id); });
  }

  return function handleAction(action: string) {
    if (!NON_REPEATABLE.has(action)) e.lastAction = action; // for "Repeat <command>"
    // sketch CREATE tools: switch tool while sketching, else start a sketch with it
    if (SKETCH_TOOLS.has(action)) {
      if (e.sketch.active) e.sketch.setTool(action as SketchTool);
      else e.starters.startSketch(action as SketchTool);
      return;
    }
    // sketch MODIFY tools only make sense inside a sketch
    if (action in SKETCH_MODIFY) {
      const tool = SKETCH_MODIFY[action];
      if (e.sketch.active) { if (tool) e.sketch.setTool(tool); }
      else e.setStatus("Enter a sketch to use modify tools", "");
      return;
    }
    if (action === "finish") return void e.sketch.finish(true);
    if (action === "palette") return void (palette.visible = true);
    // Undo/redo must be handled BEFORE the finish-the-sketch line below. They are
    // not 3D modeling commands: letting Ctrl+Z fall through would commit the sketch
    // and THEN undo it as a whole — which is the exact bug in-sketch undo exists to
    // fix, so routing it any later is silently a no-op.
    if (action === "undo") return void e.doUndo();
    if (action === "redo") return void e.doRedo();
    // a 3D modeling command finishes the active sketch first (mainstream MCAD behavior)
    if (e.sketch.active) e.sketch.finish(true);

    // The three booleans are one starter taking the operation as an argument, so
    // they are dispatched from the inventory rather than as three switch arms
    // that would differ only in a string (features/booleanOps.ts).
    const boolOp = booleanOpOfAction(action);
    if (boolOp) return void e.starters.startBoolean(boolOp);

    switch (action) {
      case "sketch":
        e.starters.startSketch();
        break;
      case "offset-plane":
        e.starters.offsetPlane();
        break;
      case "extrude":
        e.starters.startExtrude();
        break;
      case "fillet":
        e.starters.startFillet();
        break;
      case "chamfer":
        e.starters.startChamfer();
        break;
      case "presspull":
        e.starters.startPressPull();
        break;
      case "mirror":
        void e.starters.startMirror();
        break;
      case "split":
        void e.starters.startSplit();
        break;
      case "datum-plane":
        e.starters.createDatumPlane();
        break;
      case "midplane":
        e.starters.createMidplane();
        break;
      case "plane-points":
        e.starters.createPlaneThroughPoints();
        break;
      case "import":
        void importModel(e.store, e.geometry);
        break;
      case "save":
        void saveDocument(e.store);
        break;
      case "open":
        void e.openDoc();
        break;
      case "export":
        void exportModel(e.store, e.geometry);
        break;
      case "print-export":
        void exportPrintProject(e.store, e.geometry);
        break;
      case "print-orca":
        void openInOrca(e.store, e.geometry);
        break;
      case "print-send":
        void sendToPrinter(e.store, e.geometry);
        break;
      case "welcome":
        e.ui.welcome.open();
        break;
      case "revolve":
        void e.starters.startRevolve();
        break;
      case "loft":
        void e.starters.startLoft();
        break;
      case "sweep":
        void e.starters.startSweep();
        break;
      case "primitive":
        void e.starters.startPrimitive();
        break;
      case "shell":
        e.starters.startShell();
        break;
      case "offset-face":
        startFaceOffset("offsetFace");
        break;
      case "thicken":
        startFaceOffset("thicken");
        break;
      case "draft":
        e.starters.startDraft();
        break;
      case "texture":
        e.starters.startTexture();
        break;
      case "pattern-linear":
        e.starters.startPattern("linear");
        break;
      case "pattern-circular":
        e.starters.startPattern("circular");
        break;
      case "simplify-mesh":
        e.starters.startSimplifyMesh();
        break;
      case "clean-up":
        e.starters.startCleanUp();
        break;
      case "scale":
        e.starters.startScale();
        break;
      case "move":
        e.starters.startMove();
        break;
      case "measure":
        if (!e.hasBody()) {
          e.setStatus("Measure: create or import a body first", "");
          break;
        }
        e.tools.measure.start();
        break;
      case "properties":
        e.ui.panels.showProperties();
        break;
      case "change-parameters":
        openParamsDialog();
        break;
      case "section":
        // The button is the way OUT of the mode as well as in — including out of
        // the aiming step, which would otherwise be a state you could only leave
        // with Escape (pressing Section again during a pick did nothing at all,
        // because start() refuses to re-enter).
        if (e.tools.section.active || e.tools.section.picking) {
          e.tools.section.stop();
          break;
        }
        if (!e.hasBody()) {
          e.setStatus("Section: create or import a body first", "");
          break;
        }
        // "Pick" leads, and is what the user's own words asked for: cut along a
        // face or a datum plane they choose. The three world axes stay because
        // they need no aiming at all — on a part with no face facing the way you
        // want to look, Z is one click away and a pick is not.
        void (async () => {
          const src = await choose<"pick" | "X" | "Y" | "Z">("Section, cut along what?", [
            { value: "pick", label: "Face or plane", hint: "click one" },
            { value: "Z", label: "Z", hint: "horizontal cut" },
            { value: "X", label: "X" },
            { value: "Y", label: "Y" },
          ]);
          if (src === "pick") e.tools.section.start({ kind: "pick" });
          else if (src) e.tools.section.start(src);
        })();
        break;
      case "component-colors":
        if (!e.hasBody()) {
          e.setStatus("Component colors: create or import a body first", "");
          break;
        }
        e.viewport.setAnalysis(e.viewport.analysis === "component" ? "none" : "component");
        e.ui.panels.closeOverhangSettings(); // leaving draft mode
        e.setStatus(e.viewport.analysis === "component" ? "Component colors on" : "Component colors off", "");
        break;
      case "draft-analysis":
        if (!e.hasBody()) {
          e.setStatus("Draft analysis: create or import a body first", "");
          break;
        }
        e.viewport.setAnalysis(e.viewport.analysis === "draft" ? "none" : "draft");
        if (e.viewport.analysis === "draft") {
          const { dir, threshold } = e.viewport.draftConfig;
          e.setStatus(`Overhang: red = unsupported below ${threshold}° from horizontal (build ${dir})`, "");
          e.ui.panels.showOverhangSettings();
        } else {
          e.ui.panels.closeOverhangSettings();
          e.setStatus("Draft analysis off", "");
        }
        break;
      case "zebra":
        if (!e.hasBody()) {
          e.setStatus("Zebra: create or import a body first", "");
          break;
        }
        e.viewport.setZebra(!e.viewport.zebraOn);
        e.setStatus(e.viewport.zebraOn ? "Zebra stripes on (surface continuity)" : "Zebra off", "");
        break;
      case "curvature":
        if (!e.hasBody()) {
          e.setStatus("Curvature combs: create or import a body first", "");
          break;
        }
        e.viewport.setCurvatureCombs(!e.viewport.combsOn);
        e.setStatus(e.viewport.combsOn ? "Curvature combs on (edge bend visualization)" : "Curvature combs off", "");
        break;
      case "interference":
        void e.ui.panels.showInterference();
        break;
      // --- global File / View commands (also reachable from the palette) ---
      case "new":
        void e.newDocument();
        break;
      case "saveas":
        void saveDocumentAs(e.store);
        break;
      case "fit":
        e.viewport.fitView();
        break;
      case "iso":
      case "top":
      case "front":
      case "right":
        e.viewport.setStandardView(action as StandardView);
        break;
      case "persp": {
        const mode = e.viewport.cycleProjection();
        ui.projLabel = mode === "auto" ? "Auto" : mode === "ortho" ? "Ortho" : "Persp";
        break;
      }
      case "selmode": {
        const next = e.viewport.selecting === "faces" ? "bodies" : "faces";
        e.viewport.setSelectionMode(next);
        ui.selMode = next;
        break;
      }
      case "selmode-faces":
      case "selmode-bodies": {
        const mode = action === "selmode-bodies" ? "bodies" : "faces";
        e.viewport.setSelectionMode(mode);
        ui.selMode = mode;
        break;
      }
      case "toggle-xray": {
        e.viewport.toggleXray();
        break;
      }
      case "hide-selected": {
        const ids = e.viewport.getSelectedBodies();
        if (!ids.length) {
          e.setStatus("Hide: select bodies first (press 2 for body select)", "");
          break;
        }
        e.store.setBodiesVisibility(new Map(ids.map((id) => [id, false])));
        break;
      }
      case "show-all-bodies":
        e.store.setBodiesVisibility(
          new Map((e.store.buildState.result?.bodies ?? []).map((b) => [b.id, true])),
        );
        break;
      case "shortcut-help":
        toggleShortcutHUD();
        break;
      case "compute-all":
        e.setStatus("Compute All, rebuilding everything from scratch…", "");
        void e.store.computeAllNow();
        break;
    }
  };
}
