// The composition root. Statement order is the boot sequence, and the ordering notes below encode real bugs.

import { setLeftButtonOwner } from "../viewport/navigator/bindings";
import { Viewport } from "../viewport/viewport";
import { onUnitChange } from "../ui/units";
import { soleSelectedFeature } from "./featureRows";
import type { RowSelection } from "../ui/rowSelection";
import { asFeature } from "../types";
import { isSessionEnded } from "../document/session";
import { Geometry, type GeometryBackend } from "../geometry/client";
import { DocumentStore, EMPTY_DOCUMENT } from "../document/store";
import { SketchOverlay } from "../sketch/overlay";
import { profileCutCache } from "../sketch/faceFootprint";
import { SketchMode } from "../sketch/sketchMode";
import { setTextBackend } from "../sketch/textCache";
import { solveSketchFeature } from "../sketch/headlessSolve";
import { initSolver } from "../sketch/solver";
import { installAutosave, checkRecovery } from "../io/recovery";
import { installLaunchPaths } from "../io/launchPaths";
import { toast } from "../ui/toast";
import { traceFaultToast } from "../ui/traceFault";
import { logWarning } from "../ui/logStore";
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
import { MirrorTool } from "../features/mirrorTool";
import { MeasureTool } from "../features/measureTool";
import { SectionTool } from "../features/sectionTool";
import { PlaneOffsetTool } from "../features/planeOffsetTool";
import { DatumPoseTool } from "../features/datumPoseTool";
import { LightAimTool } from "../features/lightAimTool";
import { datumMoveTarget } from "../features/datumPlaneEdit";
import { RevolvePitchTool } from "../features/revolvePitchTool";
import { JointTool } from "../features/jointTool";
import { MechanismTool } from "../features/mechanismTool";
import { createFeatureStarters } from "../features/featureStarters";
import { createContextMenus } from "../ui/contextMenus";
import { createPanels } from "../ui/panels";
import { StressGlyphs } from "../viewport/stressGlyphs";
import { createBugReporter } from "../ui/bugReporter";

import { useRibbonStore } from "../stores/ribbon";
import { useCommandPaletteStore } from "../stores/commandPalette";
import { welcomeOnStartup } from "../ui/welcome";
import { Home } from "../ui/home";
import { wireHomeOnOpen } from "./homeWiring";
import { setThumbnailSource } from "../io/thumbnails";
import { scheduleStartupUpdateCheck } from "../ui/updates";
import { startWhatsNew } from "../ui/whatsNew";

import { installEngineDiedToast } from "./engineWatch";
import { activatePlugins } from "../plugins/activate";
import { safeMode } from "../ui/safeMode";
import { createSelection } from "./selection";
import { DraftTool } from "../features/draftTool";
import { ThreadTool } from "../features/threadTool";
import { TextOnFaceTool } from "../features/textOnFaceTool";
import { HoleTool } from "../features/holeTool";
import { cancelActiveTools, createToolBusy } from "./toolBusy";
import {
  createDocumentActions,
  heldEdits,
  newFromTemplate,
  openAtVersion,
  openOnBranch,
  openPathGuarded,
} from "./documentActions";
import { endPickSession } from "../ui/treePick";
import { createDatumPlanes } from "./datumPlanes";
import { createSketchVisibility } from "./sketchVisibility";
import { installRebuildBridge } from "./rebuildBridge";
import { installViewportWiring } from "./viewportWiring";
import { installIsolateCamera } from "./isolateCamera";
import { installSketchStateBridge } from "./sketchStateBridge";
import { createActions } from "./actions";
import { installKeyboard } from "./keyboard";
import { installTitlebar } from "./titlebar";
import { beforeUpdate, installUnsavedGuard } from "./unsavedGuard";
import { installContextMenuGuard } from "../ui/contextMenuGuard";
import { installPointerKind } from "../input/pointerKind";
import { installLongPress } from "../ui/longPress";
import { useUiStore } from "../stores/ui";
import { useBrowserStore } from "../stores/browser";
import { createDocBridge, type DocBridge } from "./docBridge";
import { wireDocumentSwap } from "./documentSwap";
import { watchOutOfDate } from "./staleModel";
import { LiveSessionHost } from "../live/liveSession";
import { GuideSession } from "../ui/guide/guideSession";
import { resolveTarget, takeSnapshot } from "../ui/guide/probe";
import { liveEditsAllowed, liveSharingEnabled, onLiveEditingChange } from "../ui/liveEditing";

import type { Feature, PlaneDef, PlaneSpec, Vec3 } from "../types";
import { installEnvironmentSync } from "../ui/environmentImport";
import type { DatumPose } from "../document/datumPose";

export interface EngineTools {
  extrude: ExtrudeTool;
  edgeFeature: EdgeFeatureTool;
  targetEdit: TargetEditTool;
  pressPull: PressPullTool;
  faceOffset: FaceOffsetTool;
  draft: DraftTool;
  thread: ThreadTool;
  textOnFace: TextOnFaceTool;
  hole: HoleTool;
  loft: LoftTool;
  move: MoveTool;
  pattern: PatternTool;
  mirror: MirrorTool;
  measure: MeasureTool;
  section: SectionTool;
  planeOffset: PlaneOffsetTool;
  datumPose: DatumPoseTool;
  lightAim: LightAimTool;
  revolvePitch: RevolvePitchTool;
  joint: JointTool;
  mechanism: MechanismTool;
}

export interface EngineUi {
  home: Home;
  panels: ReturnType<typeof createPanels>;
}

export interface Engine {
  canvas: HTMLCanvasElement;
  viewport: Viewport;
  geometry: GeometryBackend;
  store: DocumentStore;
  /** Shares the document with an attached assistant; always constructed, running only while live editing is on. */
  live: LiveSessionHost;
  guide: GuideSession;
  overlay: SketchOverlay;
  sketch: SketchMode;
  tools: EngineTools;
  /** The arrow on an edge or face selection. Not in `tools`: counted by toolBusy(), any selection would disable every
   *  command. */
  nudge: SelectionNudge;
  ui: EngineUi;

  starters: ReturnType<typeof createFeatureStarters>;
  menus: ReturnType<typeof createContextMenus>;
  /** Components must read it through app/useDoc.ts. */
  bridge: DocBridge;

  handleAction(action: string): void;

  /** Checked before every start* tool so nothing fires mid sketch or mid drag; read only at event time. */
  toolBusy(): boolean;
  /** toolBusy() minus the ambient Move gizmo a body selection raises, for affordances that hide while a tool owns the
   *  screen; otherwise a body selection could never show them. */
  toolOwnsScreen(): boolean;
  /** toolOwnsScreen() minus a modal (Home counts as one): a sketch or tool is at work on the document. */
  toolAtWork(): boolean;
  /** A body verb calls this first, or its own toolBusy() check refuses it. A drag let go of but not yet entered is
   *  written first, so the verb acts on where the bodies were left. */
  dropBodyGizmo(): void;
  raiseBodyGizmo(): void;
  /** Raises it again once the command dropBodyGizmo made way for is escaped, while the same bodies are selected. */
  restoreBodyGizmo(): void;
  hasBody(): boolean;
  /** Lets Alt+left orbit step aside; narrower than toolBusy, since a body selection or open sketch must still orbit. */
  altLeftOwned(): boolean;
  planePick: boolean;

  /** Write it with selectFeature. */
  readonly selectedFeature: string | null;
  /** Picked by the user rather than set by the engine (stores/selection.ts). */
  readonly selectedFeatureExplicit: boolean;
  selectFeature(id: string | null, explicit?: boolean): void;
  /** Several rows picked at once, `primary` being the one the inspector follows. */
  selectFeatureRows(next: RowSelection<string>, primary: string | null): void;
  editFeature(id: string): void;
  featureForFace(faceId: number): string | null;
  deleteSelectedFace(): boolean;
  noteCommitted(id: string | null): void;
  frameNextModel(): void;

  isSketchConsumed(id: string): boolean;
  isSketchVisible(id: string): boolean;
  datumPlaneDef(f: Extract<Feature, { type: "datumPlane" }>): PlaneDef;
  datumSourceOf(f: Extract<Feature, { type: "datumPlane" }>): PlaneSpec;
  /** Draws a datum and its dependents at a pose not yet written; null drops it. */
  previewDatumPose(id: string, pose: DatumPose | null): void;
  syncDatumPlanes(): void;

  newDocument(): Promise<void>;
  openDoc(): Promise<void>;
  doUndo(): void;
  doRedo(): void;

  lastAction: string | null;
  setStatus(text: string, cls: "" | "connected" | "error"): void;
}

let recoveryAsked: Promise<void> = Promise.resolve();

export function createEngine(canvas: HTMLCanvasElement): Engine {
  // Members are read through `e` rather than captured, so a block installed early can call one assigned later.
  const e = {} as Engine;
  e.canvas = canvas;
  e.lastAction = null;
  e.planePick = false;

  // A hint is a short toast, dropped when it repeats the one on screen; errors go to the console.
  let lastHint = { text: "", at: 0 };
  // A reconnect loop repeats its warning every attempt, once a minute is plenty.
  let lastWarning = { text: "", at: -Infinity };
  e.setStatus = (text, cls) => {
    if (!text || cls === "connected") return;
    const now = performance.now();
    if (cls === "error") {
      if (text === lastWarning.text && now - lastWarning.at < 60000) return;
      lastWarning = { text, at: now };
      logWarning(text, { source: "status" });
      return;
    }
    if (text === lastHint.text && now - lastHint.at < 3500) return;
    lastHint = { text, at: now };
    toast(text);
  };

  e.viewport = new Viewport(canvas);
  onUnitChange(() => e.viewport.requestRender());
  e.viewport.onGridStep = (mm) => {
    useUiStore().gridStepMm = mm;
  };
  e.viewport.onXrayChange = (on) => {
    useUiStore().xray = on;
  };
  e.viewport.onWireframeChange = (on) => {
    useUiStore().wireframe = on;
  };
  e.viewport.onViewModeChange = (m) => {
    useUiStore().viewMode = m;
  };
  useUiStore().viewMode = e.viewport.viewMode;
  e.viewport.onTraceStateChange = (st) => {
    useUiStore().traceState = st;
  };
  e.viewport.onTraceFault = traceFaultToast;
  e.viewport.onTraceNotice = (message) => toast(message, { kind: "warning", source: "pathtrace" });
  e.viewport.onStutterChange = (on) => {
    useUiStore().lowPerformance = on;
  };

  e.geometry = new Geometry();
  void e.geometry.init();
  installEngineDiedToast();

  e.store = new DocumentStore(e.geometry, EMPTY_DOCUMENT);
  e.geometry.bindSessions?.(e.store.sessions);
  e.store.onWarning = (msg) => toast(msg);
  e.viewport.attachStore(e.store);
  // Once, before any component exists; components read version refs instead of subscribing.
  e.bridge = createDocBridge(e.store);
  const autosave = installAutosave(e.store);
  // Safe mode offers no snapshot: one that kills the app would kill every start.
  recoveryAsked = safeMode() ? Promise.resolve() : checkRecovery(e.store);

  // After the store exists and before anything edits it, so the first publish carries a document.
  // Runs only while the setting is on, since its store subscription would keep counting revisions.
  e.live = new LiveSessionHost(e.store, e.geometry, liveEditsAllowed);
  e.guide = new GuideSession(
    (t) => resolveTarget(e, t),
    () => takeSnapshot(e),
  );
  e.live.attachGuide(e.guide);
  const syncLive = () => {
    if (liveSharingEnabled()) e.live.start();
    else void e.live.stop();
  };
  syncLive();
  onLiveEditingChange(syncLive);

  e.overlay = new SketchOverlay();
  e.viewport.addToScene(e.overlay.group, "sketches");
  e.sketch = new SketchMode(e.viewport, e.overlay);
  // Areas split where the engine cuts a consuming feature's profile, so a highlighted area is what builds. The build
  // result is the epoch, since a visibility toggle re-emits the same one.
  let opened = 0;
  e.store.onOpen(() => opened++);
  const splitAgain = () => {
    if (e.sketch.active) e.sketch.redraw();
    else if (e.toolBusy()) e.overlay.splitStale = true;
    else if (e.overlay.regions.length) e.overlay.update(e.store.document);
  };
  const cuts = profileCutCache({
    cuts: (plane, r) =>
      e.store.profileCuts(
        [plane.origin.x, plane.origin.y, plane.origin.z],
        [plane.n.x, plane.n.y, plane.n.z],
        (
          [
            [r.minx, r.miny],
            [r.maxx, r.miny],
            [r.maxx, r.maxy],
            [r.minx, r.maxy],
          ] as const
        ).map(([x, y]) => {
          const p = plane.to3D(x, y);
          return [p.x, p.y, p.z] as Vec3;
        }),
      ),
    epoch: () => e.store.buildState.result,
    document: () => opened,
    landed: splitAgain,
  });
  e.overlay.footprintFor = cuts;
  e.store.onBuild(() => {
    if (cuts.stale()) splitAgain();
  });
  // After a parameter edit closed sketches re-solve headlessly; the open one refreshes its own dims.
  e.store.headlessSolve = solveSketchFeature;
  e.store.openSketchId = () => e.sketch.openDocId;
  e.store.onParamsApplied = () => e.sketch.syncParamValues();
  // The open sketch's session owns it, so its projection refreshes patch the live entities.
  e.store.onProjectionsApplied = (updates) => e.sketch.syncProjectedCurves(updates);
  e.store.onParamSolveIssue = (id) => toast(`Sketch ${id}: dimensions can't be satisfied, geometry left unchanged`);
  // Glyph outlines arrive async from the engine, which owns the fonts.
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
    textOnFace: new TextOnFaceTool(e.viewport, e.store),
    hole: new HoleTool(e.viewport, e.store),
    loft: new LoftTool(e.viewport, e.overlay, e.store),
    move: new MoveTool(e.viewport, e.store),
    pattern: new PatternTool(e.viewport, e.store),
    mirror: new MirrorTool(e.viewport, e.store),
    measure: new MeasureTool(e.viewport),
    // Without `toolBusy` the handle and its F and G keys stay live under every other tool, without `datumDef` a
    // click on a construction plane while aiming falls through to the body behind it.
    section: new SectionTool(e.viewport, {
      toolBusy: () => e.toolBusy(),
      afterEdit: () => e.restoreBodyGizmo(),
      saved: {
        get: () => e.store.sectionView,
        set: (v) => e.store.setSectionView(v),
        onChange: (fn) => e.store.onSectionViewChange(fn),
      },
      datumDef: (id) => {
        const f = asFeature(
          e.store.document.features.find((x) => x.id === id),
          "datumPlane",
        );
        return f ? e.datumPlaneDef(f) : null;
      },
    }),
    planeOffset: new PlaneOffsetTool(e.viewport),
    datumPose: new DatumPoseTool(e.viewport),
    lightAim: new LightAimTool(e.viewport),
    revolvePitch: new RevolvePitchTool(e.viewport, e.store, e.overlay),
    joint: new JointTool(e.viewport, e.store),
    mechanism: new MechanismTool(e.viewport, e.store),
  };

  const move = e.tools.move;
  for (const h of heldEdits(e.tools)) autosave.watchHeld(h);
  e.sketch.gizmo = {
    start: (target, done) => move.startTarget(target, () => done()),
    cancel: () => move.cancel(),
    settle: () => move.settle(),
    get active() {
      return move.active;
    },
  };

  e.nudge = new SelectionNudge(e.viewport, { toolBusy: () => e.toolBusy() });

  // initSolver resolves false rather than rejecting when the WASM cannot compile (0.1.73 on Windows); the specific
  // error comes when a sketch needs to solve.
  void initSolver().then((ok) => {
    if (!ok) crumb("[solver] constraint solver unavailable, sketching without constraints");
  });

  Object.assign(e, createToolBusy(e));
  const work = { tool: false, sketch: false, planes: false };
  e.viewport.activeWork = () => {
    work.sketch = e.sketch.active;
    work.planes = e.viewport.constructionOnTop;
    work.tool = !work.sketch && (e.toolOwnsScreen() || (e.tools.move.active && !e.tools.move.ambient));
    return work;
  };
  setLeftButtonOwner(() => e.altLeftOwned());
  Object.assign(e, createSketchVisibility(e));
  // Without this the overlay's default shows every sketch, so a hidden one would still take clicks.
  e.overlay.sketchVisible = (id) => e.isSketchVisible(id);
  // A face following sketch is drawn where the build put it, or its curves and geometry disagree.
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
  e.store.onRewind(endPickSession);
  wireDocumentSwap(e.store, {
    cancelTools: () => cancelActiveTools(e.tools),
    sketch: e.sketch,
    dropBodyGizmo: () => e.dropBodyGizmo(),
    overlay: e.overlay,
    forgetLastCommit: () => {
      e.tools.extrude.lastCommit = null;
    },
    viewport: e.viewport,
    browser: useBrowserStore(),
    selectFeature: (id) => e.selectFeature(id),
  });
  watchOutOfDate(e.store, (on) => e.viewport.setModelOutOfDate(on));
  installEnvironmentSync(e.store);

  return e;
}

/** Runs right after app.mount(), since the imperative panels need the shell's containers. Subscription order matters:
 *  several store subscriptions replay on subscribe. */
export function mountUi(e: Engine): void {
  e.ui = {} as EngineUi;
  useRibbonStore().bind((a) => e.handleAction(a));

  // Global, so the palette opens from anywhere.
  const cmdk = useCommandPaletteStore();
  cmdk.bind((a) => e.handleAction(a));
  window.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "k" || ev.key === "K")) {
      ev.preventDefault();
      cmdk.toggle(e.sketch.active ? "sketch" : "model");
    }
  });

  e.ui.home = new Home({
    newDocument: () => e.newDocument(),
    openDoc: () => e.openDoc(),
    newFromTemplate: (id) => newFromTemplate(e, id),
    openPath: (path) => openPathGuarded(e, path),
    currentPath: () => e.store.filePath,
    currentVersions: () => e.store.versionRepo,
    openVersion: (path, id, copy) => openAtVersion(e, path, id, copy),
    openBranch: (path, name) => openOnBranch(e, path, name),
  });
  wireHomeOnOpen(e.store, e.ui.home);
  setThumbnailSource(() => e.viewport.renderThumbnail(480, 300));

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
    mirrorTool: e.tools.mirror,
    planeOffset: e.tools.planeOffset,
    datumPose: e.tools.datumPose,
    datumMoveTarget: (id) =>
      datumMoveTarget(
        {
          store: e.store,
          sourceOf: (f) => e.datumSourceOf(f),
          previewPose: (pid, p) => e.previewDatumPose(pid, p),
        },
        id,
      ),
    canvas: e.canvas,
    toolBusy: () => e.toolBusy(),
    hasBody: () => e.hasBody(),
    setStatus: (t, c) => e.setStatus(t, c),
    selectFeature: (id, explicit) => e.selectFeature(id, explicit),
    noteCommitted: (id) => e.noteCommitted(id),
    isSketchConsumed: (id) => e.isSketchConsumed(id),
    // Starters that need exactly one feature see none while several rows are picked, and ask for a pick as usual.
    getSelectedFeature: () => soleSelectedFeature(e),
    getSelectedFeatureExplicit: () => e.selectedFeatureExplicit,
    setPlanePick: (v) => {
      e.planePick = v;
    },
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
    setLastAction: (a) => {
      e.lastAction = a;
    },
    startCutByPlane: (id) => e.starters.startCutByPlane(id),
    offsetPlaneFromFace: (...args) => e.starters.offsetPlaneFromFace(...args),
    axisFromRoundFace: (...args) => e.starters.axisFromRoundFace(...args),
    exportFlat: (source, format) =>
      void import("../io/files").then((m) => m.exportModel(e.store, e.geometry, [], source, format)),
  });

  e.ui.panels = createPanels({
    store: e.store,
    viewport: e.viewport,
    geometry: e.geometry,
    hasBody: () => e.hasBody(),
    setStatus: (t, c) => e.setStatus(t, c),
    stressGlyphs: (handlers) => new StressGlyphs(e.viewport, handlers),
  });

  // After menus, panels and starters, which reach back to it through thunks.
  e.handleAction = createActions(e);

  if (welcomeOnStartup()) e.ui.home.open();
  void startWhatsNew(e.ui.home);
  installLaunchPaths(e, recoveryAsked);
  scheduleStartupUpdateCheck(beforeUpdate(e));

  installTitlebar(e);
  installUnsavedGuard(e);
  installContextMenuGuard();
  installPointerKind();
  installLongPress();
  installViewportWiring(e);
  installIsolateCamera(e.store, e.viewport);
  installRebuildBridge(e);
  installSketchStateBridge(e);
  installKeyboard(e);

  createBugReporter({
    store: e.store,
    geometry: e.geometry,
    viewport: e.viewport,
    sketch: e.sketch,
  });
  // The engine does not know which capabilities exist (plugins/activate.ts).
  if (!safeMode()) activatePlugins(e);

  e.geometry.onStatus((connected) => {
    if (!connected) e.setStatus("connecting to the geometry engine…", "error");
    else
      e.store.rebuildNow().catch((err: unknown) => {
        if (!isSessionEnded(err)) throw err;
      });
  });
}
