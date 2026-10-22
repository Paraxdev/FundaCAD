import { saveDocument, saveDocumentAs, exportSelection, importModel } from "../io/files";
import { setWorkspace } from "../ui/workspace";
import { chooseViewMode, nextViewMode, requestPathTraced, toggleCleanView, type ViewMode } from "../ui/viewMode";
import { contributedAction } from "../plugins/contrib";
import { openParamsDialog } from "../ui/paramsDialog";
import { toggleShortcutHUD } from "../input/shortcuts";
import { choose } from "../ui/choice";
import { endPickSession } from "../ui/treePick";
import { SKETCH_TOOLS, SKETCH_MODIFY, NON_REPEATABLE } from "./actionTables";
import { booleanOpOfAction } from "../features/booleanOps";
import { useUiStore } from "../stores/ui";
import { useSketchPaletteStore } from "../stores/sketchPalette";
import type { Engine } from "./engine";
import type { SketchTool } from "../sketch/sketchMode";
import { isChoiceOpen } from "../ui/choice";
import { openReportDialog } from "../ui/bugReporter";
import { ideaUrl } from "../ui/reportText";
import { MANUAL_URL, openExternal } from "../ui/welcome";
import type { StandardView } from "../viewport/cameras";
import type { FaceOffsetMode } from "../features/faceOffsetTool";

/** View actions leave the model alone, so a pick still waiting survives them. */
const KEEPS_PICK = new Set([
  "fit",
  "reset-camera",
  "iso",
  "top",
  "front",
  "right",
  "persp",
  "selmode",
  "selmode-auto",
  "selmode-faces",
  "selmode-bodies",
  "toggle-xray",
  "toggle-wireframe",
  "zebra",
  "curvature",
  "draft-analysis",
  "shortcut-help",
  "viewmode-matcap",
  "viewmode-realtime",
  "viewmode-pathtraced",
  "viewmode-cycle",
  "viewmode-cycle-back",
  "clean-view",
]);

/** A body selection raises Move, which toolBusy() counts, so these stand it down first or they refuse silently. */
const BODY_VERBS = new Set(["mirror", "pattern-linear", "pattern-circular"]);

/** The one dispatcher for the ribbon, the keymap, the command palette and every context menu. */
export function createActions(e: Engine): (action: string) => void {
  const ui = useUiStore();
  const palette = useSketchPaletteStore();

  function startFaceOffset(mode: FaceOffsetMode) {
    if (e.toolBusy()) return;
    if (!e.hasBody()) {
      e.setStatus("Create or import a body first", "");
      return;
    }
    e.tools.faceOffset.start(mode, (id) => {
      if (id) e.selectFeature(id, false);
    });
  }

  function startFaceTool(which: "draft" | "thread" | "hole" | "textOnFace") {
    if (e.toolBusy()) return;
    if (!e.hasBody()) {
      e.setStatus("Create or import a body first", "");
      return;
    }
    e.tools[which].start((id) => {
      if (id) e.selectFeature(id, false);
    });
  }

  return function handleAction(action: string) {
    // A contributed action is never repeated: the core cannot tell whether running it twice is safe.
    if (!NON_REPEATABLE.has(action) && !contributedAction(action)) e.lastAction = action;
    if (SKETCH_TOOLS.has(action)) {
      if (e.sketch.active) e.sketch.setTool(action as SketchTool);
      else {
        endPickSession();
        e.starters.startSketch(action as SketchTool);
      }
      return;
    }
    if (action in SKETCH_MODIFY) {
      const tool = SKETCH_MODIFY[action];
      if (e.sketch.active) {
        if (tool && !e.sketch.applySelectedConstraint(tool)) e.sketch.setTool(tool);
      } else e.setStatus("Enter a sketch to use modify tools", "");
      return;
    }
    if (action === "finish") return void e.sketch.finish(true);
    if (action === "tie-loose-ends") {
      if (e.sketch.active) void e.sketch.tieLooseEnds();
      else e.setStatus("Enter a sketch to tie its loose ends", "");
      return;
    }
    if (action === "palette") return void (palette.visible = true);
    // Before the sketch finish below, so a sketch open when the problem showed is reported open.
    if (action === "report-problem") return openReportDialog();
    if (action === "suggest-idea") return void openExternal(ideaUrl());
    if (action === "manual") return void openExternal(MANUAL_URL);
    // The arrow keys turn the view and nothing else: they leave a sketch open,
    // and a tool that reads the arrows itself (the pattern count) keeps them.
    const step = /^view-step-(left|right|up|down)(-fine)?$/.exec(action);
    if (step) {
      if (isChoiceOpen() || (!e.sketch.active && e.toolBusy())) return;
      e.viewport.stepView(step[1] as "left" | "right" | "up" | "down", !!step[2]);
      return;
    }
    // Before the finish below, or Ctrl+Z would commit the sketch and then undo it whole.
    if (action === "undo") return void e.doUndo();
    if (action === "redo") return void e.doRedo();
    if (e.sketch.active) e.sketch.finish(true);
    // Section pressed during its own aiming is its way out.
    if (!KEEPS_PICK.has(action) && !(action === "section" && e.tools.section.picking)) endPickSession();

    const boolOp = booleanOpOfAction(action);
    if (boolOp || BODY_VERBS.has(action)) {
      e.dropBodyGizmo();
      e.restoreBodyGizmo();
    }
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
      case "separate":
        void e.starters.startSeparate();
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
      case "datum-point":
        e.starters.createDatumPoint();
        break;
      case "datum-axis":
        e.starters.createDatumAxis();
        break;
      case "datum-axis-edge":
        e.starters.createDatumAxisOnEdge();
        break;
      case "plane-normal-edge":
        e.starters.createPlaneNormalToEdge();
        break;
      case "plane-two-edges":
        e.starters.createPlaneThroughEdges();
        break;
      case "plane-angle":
        e.starters.createPlaneAtAngle();
        break;
      case "axis-cylinder":
        e.starters.createAxisFromCylinder();
        break;
      case "axis-planes":
        e.starters.createAxisFromPlanes();
        break;
      case "import":
        void importModel(e.store, e.geometry);
        break;
      case "insert-document":
        void import("../io/fundaLinks").then((m) => m.insertDocumentFromDialog(e.store, e.geometry));
        break;
      case "save":
        void saveDocument(e.store);
        break;
      case "open":
        void e.openDoc();
        break;
      case "export":
        void exportSelection(e.store, e.geometry, e.viewport);
        break;
      case "welcome":
        e.ui.home.open();
        break;
      case "materials":
        setWorkspace("render");
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
        startFaceOffset("shell");
        break;
      case "joint":
        e.starters.startJoint();
        break;
      case "mechanism":
        void e.starters.startMechanism();
        break;
      case "offset-face":
        startFaceOffset("offsetFace");
        break;
      case "thicken":
        startFaceOffset("thicken");
        break;
      case "draft":
        startFaceTool("draft");
        break;
      case "hole":
        startFaceTool("hole");
        break;
      case "thread":
        startFaceTool("thread");
        break;
      case "text-on-face":
        startFaceTool("textOnFace");
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
        if (e.tools.move.active && e.tools.move.ambient) e.tools.move.claim();
        else e.starters.startMove();
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
        // The button is the way out of every phase too, start() refuses to re-enter.
        if (e.tools.section.active || e.tools.section.picking) {
          e.tools.section.stop();
          break;
        }
        if (!e.hasBody()) {
          e.setStatus("Section: create or import a body first", "");
          break;
        }
        // Its handle, box and keys would stay live beside the other tool's until that ends.
        if (e.toolAtWork()) {
          e.setStatus("Section: finish the active tool first (Esc cancels it)", "");
          break;
        }
        // The world axes need no aiming, for a part with no face turned the way you want to look.
        void (async () => {
          const src = await choose<"pick" | "X" | "Y" | "Z">("Section, cut along what?", [
            { value: "pick", label: "Face or plane", hint: "click one" },
            { value: "Z", label: "Z", hint: "horizontal cut" },
            { value: "X", label: "X" },
            { value: "Y", label: "Y" },
          ]);
          if (!src) return;
          e.dropBodyGizmo();
          e.tools.section.start(src === "pick" ? { kind: "pick" } : src);
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
      case "stress":
        e.ui.panels.showStress();
        break;
      case "new":
        void e.newDocument();
        break;
      case "saveas":
        void saveDocumentAs(e.store);
        break;
      case "fit":
        e.viewport.fitView();
        break;
      case "reset-camera":
        e.viewport.resetCamera();
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
        const order = ["auto", "faces", "bodies"] as const;
        const next = order[(order.indexOf(e.viewport.policy) + 1) % order.length]!;
        e.viewport.setSelectPolicy(next);
        ui.selMode = next;
        break;
      }
      case "selmode-auto":
      case "selmode-faces":
      case "selmode-bodies": {
        const mode = action === "selmode-bodies" ? "bodies" : action === "selmode-faces" ? "faces" : "auto";
        e.viewport.setSelectPolicy(mode);
        ui.selMode = mode;
        break;
      }
      case "toggle-xray": {
        e.viewport.toggleXray();
        break;
      }
      case "toggle-wireframe": {
        e.viewport.setWireframe(!e.viewport.isWireframe);
        break;
      }
      case "clean-view": {
        toggleCleanView();
        break;
      }
      case "viewmode-matcap":
      case "viewmode-realtime":
      case "viewmode-pathtraced": {
        const tier = e.viewport.renderTier;
        const mode = action.slice("viewmode-".length) as ViewMode;
        if (mode === "pathtraced") {
          const ask = requestPathTraced(tier);
          if (ask.result === "warn" || ask.result === "blocked") {
            e.setStatus(ask.message, "");
            break;
          }
          if (ask.result === "enabled") e.viewport.tierChanged();
        }
        chooseViewMode(mode, e.viewport.renderTier);
        break;
      }
      case "viewmode-cycle":
      case "viewmode-cycle-back": {
        const tier = e.viewport.renderTier;
        chooseViewMode(nextViewMode(e.viewport.viewMode, action === "viewmode-cycle" ? 1 : -1, tier), tier);
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
        e.store.setBodiesVisibility(new Map((e.store.buildState.result?.bodies ?? []).map((b) => [b.id, true])));
        break;
      case "shortcut-help":
        toggleShortcutHUD();
        break;
      case "compute-all":
        e.setStatus("Compute All, rebuilding everything from scratch…", "");
        void e.store.computeAllNow();
        break;
      // Plugins come last, so a contribution naming "save" or "export" cannot replace the app's own.
      default:
        contributedAction(action)?.();
        break;
    }
  };
}
