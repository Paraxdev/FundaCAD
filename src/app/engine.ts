// The composition root, formerly the top 950 lines of main.ts.
//
// main.ts was 1363 lines of bare top-level statements: import order and
// statement order WERE the boot sequence, and ~25 singletons referred to each
// other through function-declaration hoisting. Moving that across module
// boundaries loses hoisting, so the mutual references are resolved the way
// main.ts already resolved getLastAction/setLastAction, late-bound members on
// one mutable record, assigned in the same order the statements used to run.
//
// The ordering constraints that were documented as comments in main.ts are kept
// as comments HERE, next to the lines they constrain. They are not stylistic:
// several of them encode bugs that took multiple rounds to find.

import { Viewport } from "../viewport/viewport";
import { asFeature } from "../types";
import { Geometry, type GeometryBackend } from "../geometry/client";
import { TauriGeometry } from "../geometry/tauriClient";
import { DocumentStore, EMPTY_DOCUMENT } from "../document/store";
import { SketchOverlay } from "../sketch/overlay";
import { footprintCache } from "../sketch/faceFootprint";
import { SketchMode } from "../sketch/sketchMode";
import { setTextBackend } from "../sketch/textCache";
import { solveSketchFeature } from "../sketch/headlessSolve";
import { initSolver } from "../sketch/solver";
import { installAutosave, checkRecovery } from "../io/recovery";
import { toast } from "../ui/toast";
import { crumb } from "../diagnostics/breadcrumbs";

import { ExtrudeTool } from "../features/extrudeTool";
import { EdgeFeatureTool } from "../features/edgeFeatureTool";
import { TargetEditTool } from "../features/targetEditTool";
import { SelectionNudge } from "../features/selectionNudge";
import { PressPullTool } from "../features/pressPullTool";
import { FaceOffsetTool } from "../features/faceOffsetTool";
import { LoftTool } from "../features/loftTool";
import { MoveTool } from "../features/moveTool";
import { PatternTool } from "../features/patternTool";
import { MeasureTool } from "../features/measureTool";
import { SectionTool } from "../features/sectionTool";
import { PlaneOffsetTool } from "../features/planeOffsetTool";
import { RevolvePitchTool } from "../features/revolvePitchTool";
import { JointTool } from "../features/jointTool";
import { createFeatureStarters } from "../features/featureStarters";
import { createContextMenus } from "../ui/contextMenus";
import { createPanels } from "../ui/panels";
import { createBugReporter } from "../ui/bugReporter";

import { useRibbonStore } from "../stores/ribbon";
import { useCommandPaletteStore } from "../stores/commandPalette";
import { WelcomeScreen, welcomeOnStartup } from "../ui/welcome";
import { scheduleStartupUpdateCheck } from "../ui/updates";
import { openDocumentAtPath } from "../io/files";

import { installSidecarDiedToast } from "./sidecarWatch";
import { activatePlugins } from "../plugins/activate";
import { createSelection } from "./selection";
import { DraftTool } from "../features/draftTool";
import { ThreadTool } from "../features/threadTool";
import { createToolBusy } from "./toolBusy";
import { createDocumentActions } from "./documentActions";
import { createDatumPlanes } from "./datumPlanes";
import { createSketchVisibility } from "./sketchVisibility";
import { installRebuildBridge } from "./rebuildBridge";
import { installViewportWiring } from "./viewportWiring";
import { installSketchStateBridge } from "./sketchStateBridge";
import { createActions } from "./actions";
import { installKeyboard } from "./keyboard";
import { installTitlebar } from "./titlebar";
import { useUiStore } from "../stores/ui";
import { createDocBridge, type DocBridge } from "./docBridge";
import { LiveSessionHost } from "../live/liveSession";
import { liveEditsAllowed, liveSharingEnabled, onLiveEditingChange } from "../ui/liveEditing";

import type { Feature, PlaneDef } from "../types";

export interface EngineTools {
  extrude: ExtrudeTool;
  edgeFeature: EdgeFeatureTool;
  targetEdit: TargetEditTool;
  pressPull: PressPullTool;
  faceOffset: FaceOffsetTool;
  draft: DraftTool;
  thread: ThreadTool;
  loft: LoftTool;
  move: MoveTool;
  pattern: PatternTool;
  measure: MeasureTool;
  section: SectionTool;
  planeOffset: PlaneOffsetTool;
  revolvePitch: RevolvePitchTool;
  joint: JointTool;
}

export interface EngineUi {
  welcome: WelcomeScreen;
  panels: ReturnType<typeof createPanels>;
}

export interface Engine {
  canvas: HTMLCanvasElement;
  viewport: Viewport;
  geometry: GeometryBackend;
  store: DocumentStore;
  /** Publishes this window's document to an attached assistant, and applies the
   *  edits it offers. Always constructed; running only while the live-editing
   *  setting is on. */
  live: LiveSessionHost;
  overlay: SketchOverlay;
  sketch: SketchMode;
  tools: EngineTools;
  /** The arrow offered on an edge or face selection. ONE instance, because only
   *  one thing can be offered at a time and two arrows in the viewport would be
   *  two things to grab. Deliberately NOT in `tools`: it holds no document
   *  state and must never appear in toolBusy(), or selecting anything would
   *  silently disable every command in the app. */
  nudge: SelectionNudge;
  ui: EngineUi;

  starters: ReturnType<typeof createFeatureStarters>;
  menus: ReturnType<typeof createContextMenus>;
  /** DocumentStore's callback channels, mirrored as version refs. See
   *  app/useDoc.ts for how components must consume it. */
  bridge: DocBridge;

  /** The single action dispatcher, ribbon, keymap, command palette and every
   *  context menu funnel through this one function. */
  handleAction(action: string): void;

  /** Guard checked at the top of every start* tool and interactive helper: they
   *  can't fire mid-sketch / mid-drag. Deliberately a plain function, not
   *  reactive state, it is only ever read at event time. */
  toolBusy(): boolean;
  /** toolBusy(), minus the Move gizmo.
   *
   *  For an AMBIENT affordance, one the app raises off the selection rather
   *  than one the user started: the selection toolbar, and anything else that
   *  hides itself while a tool owns the screen.
   *
   *  The distinction exists because picking a body raises the Move gizmo by
   *  itself (viewportWiring.onBodySelectionChange, "picking a body IS reaching
   *  for it"), so for a body selection toolBusy() is true from the instant
   *  there is a selection to offer anything about. That is the same kind of
   *  thing as `nudge`, the handle a selection carries, and the note on `nudge`
   *  says why such a thing must never read as busy: it is not a mode you
   *  entered, and hiding the offer for it hides the offer always.
   *
   *  Every other entry still counts, including a Move started deliberately over
   *  a selection that is not a body's, which is a mode. */
  toolOwnsScreen(): boolean;
  /** Stand the ambient Move gizmo down, so a body verb can run.
   *
   *  The other half of toolOwnsScreen. Showing an offer over a body is not
   *  enough: `actions.ts` and every start* helper begin with their own
   *  `if (toolBusy()) return`, and the gizmo a body selection raises makes that
   *  true, so Pattern, the booleans and Remove Body were all refused with
   *  "Finish the active tool first" from a menu that had just offered them.
   *
   *  A surface that acts on a body selection calls this first. Nothing is lost:
   *  a drag that changed anything has already committed on pointerup
   *  (MoveTool.onUp), so the gizmo this cancels is always an untouched one, and
   *  cancelling leaves the selection it was raised on alone. */
  dropBodyGizmo(): void;
  /** True when the current rebuild produced a solid body (something to modify). */
  hasBody(): boolean;
  planePick: boolean;

  /** Read-only accessor over the selection store, write it with selectFeature. */
  readonly selectedFeature: string | null;
  selectFeature(id: string | null): void;
  editFeature(id: string): void;
  featureForFace(faceId: number): string | null;
  deleteSelectedFace(): boolean;
  noteCommitted(id: string | null): void;

  isSketchConsumed(id: string): boolean;
  isSketchVisible(id: string): boolean;
  datumPlaneDef(f: Extract<Feature, { type: "datumPlane" }>): PlaneDef;
  syncDatumPlanes(): void;

  newDocument(): Promise<void>;
  openDoc(): Promise<void>;
  doUndo(): void;
  doRedo(): void;

  lastAction: string | null;
  setStatus(text: string, cls: "" | "connected" | "error"): void;
}

export function createEngine(canvas: HTMLCanvasElement): Engine {
  // Filled top-to-bottom in exactly the order main.ts's statements ran. Members
  // are read through `e` rather than captured, so a block installed early can
  // still call one assigned later (what hoisting used to buy).
  const e = {} as Engine;
  e.canvas = canvas;
  e.lastAction = null;
  e.planePick = false;

  // Was `statusEl.textContent = …; statusEl.className = \`status ${cls}\``.
  // The pinia instance is created and made active in main.ts BEFORE this runs,
  // so a store is usable here even though no component has mounted yet.
  e.setStatus = (text, cls) => useUiStore().setStatus(text, cls);

  e.viewport = new Viewport(canvas);
  // The grid spacing follows the zoom, so what one square is worth is a fact
  // about the view that only the view knows and only the chrome can show.
  e.viewport.onGridStep = (mm) => { useUiStore().gridStepMm = mm; };
  // See-through has no other tell once the model happens to be see-through for
  // another reason (a sketch dims it too), so the view bar's button is what
  // says which mode you are in.
  e.viewport.onXrayChange = (on) => { useUiStore().xray = on; };

  e.geometry = import.meta.env.VITE_GEOM === "rust" ? new TauriGeometry() : new Geometry();
  void e.geometry.init(); // fetch the per-launch sidecar auth token + open the socket
  installSidecarDiedToast();

  // Start on a blank canvas. It used to open a built-in example bracket, which
  // meant every launch began by rebuilding geometry nobody asked for, and "File →
  // New" was the first thing most people did. Recovery still restores real work
  // (checkRecovery below), so the only thing lost is the sample.
  e.store = new DocumentStore(e.geometry, EMPTY_DOCUMENT);
  e.store.onWarning = (msg) => toast(msg);
  // The Viewport is constructed before the store, and used to reach the store
  // back through `(window as any).store`, which main.ts only ever set under
  // import.meta.env.DEV, so the ViewCube's persisted side overrides silently did
  // nothing in a production build. Both live in this one function now, so hand
  // it over directly.
  e.viewport.attachStore(e.store);
  // Subscribe ONCE, here, before any component exists, components read version
  // refs rather than adding their own store subscriptions.
  e.bridge = createDocBridge(e.store);
  // crash-safety: periodic recovery snapshots + restore-on-launch prompt
  installAutosave(e.store);
  void checkRecovery(e.store);

  // Sharing this window's document with an assistant working through MCP. AFTER
  // the store exists and before anything can edit it, so the very first publish
  // carries a document rather than a null. Started only if the setting says so,
  // and stopped and restarted when it changes, the loop holds a subscription to
  // the store, so leaving it running in "off" would keep counting revisions for
  // a session nobody is in.
  e.live = new LiveSessionHost(e.store, e.geometry, liveEditsAllowed);
  const syncLive = () => {
    if (liveSharingEnabled()) e.live.start();
    else void e.live.stop();
  };
  syncLive();
  onLiveEditingChange(syncLive);

  e.overlay = new SketchOverlay();
  e.viewport.addToScene(e.overlay.group);
  e.sketch = new SketchMode(e.viewport, e.overlay);
  // Committed sketches get the same cut at the model's edge the open one gets.
  // The build RESULT is the cache epoch: its identity changes on a real rebuild
  // and stays put across a visibility toggle, which is exactly when the footprint
  // does and does not have to be re-walked.
  e.overlay.footprintFor = footprintCache({
    edges: () => e.viewport.visibleEdgeLines(),
    modelScale: () => e.viewport.modelDiagonal() ?? 0,
    epoch: () => e.store.buildState.result,
  });
  // params engine ↔ sketcher plumbing: closed sketches re-solve headlessly after
  // a parameter edit; the open one refreshes its live dim values itself.
  e.store.headlessSolve = solveSketchFeature;
  e.store.openSketchId = () => e.sketch.openDocId;
  e.store.onParamsApplied = () => e.sketch.syncParamValues();
  // projection refresh entries for the OPEN sketch bypass the doc (the session
  // owns it) and patch the live entities instead
  e.store.onProjectionsApplied = (updates) => e.sketch.syncProjectedCurves(updates);
  e.store.onParamSolveIssue = (id) =>
    toast(`Sketch ${id}: dimensions can't be satisfied, geometry left unchanged`);
  // Sidecar owns fonts: glyph outlines arrive async via tessellateText; repaint the
  // right surface (active sketch or committed overlay) when they land.
  setTextBackend(e.geometry, () => {
    if (e.sketch.active) e.sketch.redraw();
    else e.overlay.update(e.store.document);
  });

  e.tools = {
    extrude: new ExtrudeTool(e.viewport, e.overlay, e.store),
    edgeFeature: new EdgeFeatureTool(e.viewport, e.store),
    targetEdit: new TargetEditTool(e.viewport, e.store),
    pressPull: new PressPullTool(e.viewport, e.store),
    faceOffset: new FaceOffsetTool(e.viewport, e.store),
    draft: new DraftTool(e.viewport, e.store),
    thread: new ThreadTool(e.viewport, e.store),
    loft: new LoftTool(e.viewport, e.overlay, e.store),
    move: new MoveTool(e.viewport, e.store),
    pattern: new PatternTool(e.viewport, e.store),
    measure: new MeasureTool(e.viewport),
    // Both deps are late-bound through `e` for the usual reason, and both are
    // load-bearing: without `toolBusy` the section's handle and its bare F/G keys
    // stay live underneath every other tool (two grabbable glyphs on screen, and
    // an Escape fight), and without `datumDef` clicking a construction plane
    // while aiming the cut falls through to the body behind it.
    section: new SectionTool(e.viewport, {
      toolBusy: () => e.toolBusy(),
      datumDef: (id) => {
        const f = asFeature(e.store.document.features.find((x) => x.id === id), "datumPlane");
        return f ? e.datumPlaneDef(f) : null;
      },
    }),
    planeOffset: new PlaneOffsetTool(e.viewport),
    revolvePitch: new RevolvePitchTool(e.viewport, e.store, e.overlay),
    joint: new JointTool(e.viewport, e.store),
  };

  const move = e.tools.move;
  e.sketch.gizmo = {
    start: (target, done) => move.startTarget(target, () => done()),
    cancel: () => move.cancel(),
    get active() { return move.active; },
  };

  // Reads e.toolBusy, assigned below, hence the thunk, the same late binding
  // every other block in this file uses.
  e.nudge =new SelectionNudge(e.viewport, { toolBusy: () => e.toolBusy() });

  // Warm up the constraint solver WASM. Deliberately ignores failure: initSolver
  // resolves false rather than rejecting, so a runtime that cannot compile the
  // module no longer greets the user with a nameless "Something went wrong" at
  // startup (field report, 0.1.73 on Windows). The real, specific error is raised
  // if and when a sketch actually needs to solve.
  void initSolver().then((ok) => {
    if (!ok) crumb("[solver] constraint solver unavailable, sketching without constraints");
  });

  // --- predicates the UI wiring below depends on ---
  Object.assign(e, createToolBusy(e));
  Object.assign(e, createSketchVisibility(e));
  // The overlay declared this hook and nothing ever assigned it, so its default
  // ("everything is visible") stood: a sketch hidden from the browser tree kept
  // drawing its curves AND kept its region fills in the pick list, so clicking
  // the face underneath selected the hidden profile instead. Wired here rather
  // than in the SketchOverlay constructor because isSketchVisible is only
  // Object.assign'd onto the engine on the line above.
  e.overlay.sketchVisible = (id) => e.isSketchVisible(id);
  // Wired here for the same reason as the line above: only the engine can see
  // the build state, and a sketch that follows a face has to be DRAWN where the
  // build put it or the curves and the geometry cut from them disagree.
  e.overlay.resolvedPlanes = () => {
    const r = e.store.buildState.result;
    return {
      ...(r?.sketchPlanes ? { sketchPlanes: r.sketchPlanes } : {}),
      ...(r?.datumPlanes ? { datumPlanes: r.datumPlanes } : {}),
    };
  };
  Object.assign(e, createDatumPlanes(e));
  Object.assign(e, createSelection(e));
  Object.assign(e, createDocumentActions(e));

  return e;
}

/** Everything from main.ts's `// --- UI ---` marker onward.
 *
 *  Split out of createEngine for one reason: the panels that are still
 *  imperative classes take a container element from the shell, and the shell no
 *  longer exists until Vue has mounted. main.ts calls this immediately after
 *  app.mount(), which is synchronous, so the only change to the original boot
 *  sequence is that a mount happens in the middle of it. Relative order within
 *  each half is untouched, which matters: several store subscriptions replay on
 *  subscribe, so who subscribes first is observable. */
export function mountUi(e: Engine): void {
  e.ui = {} as EngineUi;
  // The tool rail is components/shell/ToolRail.vue; it renders itself from the
  // store, so all that is left here is handing it the dispatcher.
  useRibbonStore().bind((a) => e.handleAction(a));

  // Cmd/Ctrl-K command palette, search + run any command (discoverability safety net).
  // The overlay is components/overlays/CommandPalette.vue; this keeps the one
  // binding that has to be global, because the palette must open from anywhere.
  const cmdk = useCommandPaletteStore();
  cmdk.bind((a) => e.handleAction(a));
  window.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "k" || ev.key === "K")) {
      ev.preventDefault();
      cmdk.toggle(e.sketch.active ? "sketch" : "model");
    }
  });

  e.ui.welcome = new WelcomeScreen({
    onNew: () => void e.newDocument(),
    onOpen: () => void e.openDoc(),
    onOpenPath: async (path) => {
      if (e.sketch.active) e.sketch.cancel(); // same guard as openDoc
      return openDocumentAtPath(e.store, path, e.geometry);
    },
  });

  e.starters = createFeatureStarters({
    store: e.store,
    viewport: e.viewport,
    overlay: e.overlay,
    sketch: e.sketch,
    extrude: e.tools.extrude,
    edgeFeature: e.tools.edgeFeature,
    pressPull: e.tools.pressPull,
    loftTool: e.tools.loft,
    moveTool: e.tools.move,
    patternTool: e.tools.pattern,
    planeOffset: e.tools.planeOffset,
    canvas: e.canvas,
    toolBusy: () => e.toolBusy(),
    hasBody: () => e.hasBody(),
    setStatus: (t, c) => e.setStatus(t, c),
    selectFeature: (id) => e.selectFeature(id),
    noteCommitted: (id) => e.noteCommitted(id),
    isSketchConsumed: (id) => e.isSketchConsumed(id),
    getSelectedFeature: () => e.selectedFeature,
    setPlanePick: (v) => { e.planePick = v; },
  });

  e.menus = createContextMenus({
    store: e.store,
    viewport: e.viewport,
    sketch: e.sketch,
    measure: e.tools.measure,
    toolBusy: () => e.toolBusy(),
    toolOwnsScreen: () => e.toolOwnsScreen(),
    dropBodyGizmo: () => e.dropBodyGizmo(),
    setStatus: (t, c) => e.setStatus(t, c),
    selectFeature: (id) => e.selectFeature(id),
    editFeature: (id) => e.editFeature(id),
    featureForFace: (id) => e.featureForFace(id),
    deleteSelectedFace: () => e.deleteSelectedFace(),
    syncDatumPlanes: () => e.syncDatumPlanes(),
    datumPlaneDef: (f) => e.datumPlaneDef(f),
    handleAction: (a) => e.handleAction(a),
    getLastAction: () => e.lastAction,
    setLastAction: (a) => { e.lastAction = a; },
    startCutByPlane: (id) => e.starters.startCutByPlane(id),
    offsetPlaneFromFace: (...args) => e.starters.offsetPlaneFromFace(...args),
  });

  e.ui.panels = createPanels({
    store: e.store,
    viewport: e.viewport,
    geometry: e.geometry,
    hasBody: () => e.hasBody(),
    setStatus: (t, c) => e.setStatus(t, c),
  });

  // handleAction closes over `menus`/`panels`/`starters`, and those close back
  // over handleAction through the thunks above, assign it once they exist.
  e.handleAction = createActions(e);

  // (The menubar is components/shell/MenuBar.vue now, TitleBar.vue calls
  // buildMenubar(engine) itself, so there is nothing to construct here.)

  // show the welcome screen unless the user turned it off (its footer checkbox)
  if (welcomeOnStartup()) e.ui.welcome.open();
  scheduleStartupUpdateCheck();

  installTitlebar(e);
  installViewportWiring(e);
  installRebuildBridge(e);
  installSketchStateBridge(e);
  installKeyboard(e);

  createBugReporter({
    store: e.store,
    geometry: e.geometry,
    viewport: e.viewport,
    sketch: e.sketch,
  }); // floating bug icon, bottom-right
  // Whatever capabilities are turned on, started here and restarted whenever
  // that set changes. The engine deliberately does not know which ones exist:
  // see plugins/activate.ts.
  activatePlugins(e);

  e.geometry.onStatus((connected) => {
    if (!connected) e.setStatus("connecting to sidecar…", "error");
    else void e.store.rebuildNow();
  });

}
