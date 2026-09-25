// The modal sketch environment: enter on a plane (camera squares to it, model
// dims, grid appears), draw Line/Rectangle/Circle interactively with snapping
// and on-canvas dimension input, then Finish to commit the sketch feature.

import * as THREE from "three";
import { asFeature } from "../types";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { Feature, ParamTarget, PlaneSpec, ProjectionUpdate, Selector, SketchConstraint, SketchPattern } from "../types";
import { applyProjectionUpdate, dimPlaceOf, isBadgeEntity, isPlacedDim } from "../types";
import { SketchPlane } from "./plane";
import { SketchOverlay, type WorldRegion, controlPolygonObjects, curveObjects, poleMarkerObjects, dimensionLineObjects, CURVE_COLOR, PREVIEW_COLOR, SELECT_COLOR } from "./overlay";
import { constrainedPoles, degreeChoices, deletePole, insertPole, polygonParam, splineToBspline, type BsplineEntity } from "./bsplineEdit";
import { bsplineDegree, bsplineMinPoles, poleOfRef } from "./bspline";
import { DimInput } from "./dimInput";
import { TextPanel } from "./textPanel";
import type { TextValues } from "./textPanel";
import { fetchFonts } from "./textCache";
import { isEditableTarget } from "../ui/focus";
import { SketchDimensions, type ExtraDim } from "./sketchDimensions";
import { SketchGlyphs } from "./sketchGlyphs";
import { RelationsPanel } from "./relationsPanel";
import { constraintGlyphs, diagnosisOf, patternGlyphs } from "./glyphs";
import { asRound, entityDims, constraintDims, dimRefPoints, curveKind, setDimPixelScale, staggeredDefaults, type DimField, type ConstraintDim } from "./entityDims";
import { clampPlace, pickDimTarget } from "./dimensionTool";
import { pickEntity, PROJECTED_FIXED_MSG } from "./modify";
import { newEntityId, newConstraintId, isDimConstraint, notePatternId } from "./id";
import { SketchHistory, cloneSnapshot, type SketchSnapshot } from "./history";
import { isPlainNumber, parseField } from "../ui/units";
import { RIGID_ENTITY_NUM_FIELDS, coerceForField, type FieldKind } from "../document/numFields";
import type { SketchBinding } from "../document/store";
import { circumcenter } from "./arc";
import { compileAndSolve, coincKey, constraintIndexOf } from "./sketchSolve";
import { SolverUnavailable } from "./solver";
import { resolveRealEntities, toSketchEntity } from "./resolve";
import { applyDrivingDimsDirect } from "./directDims";
import { expandPattern, translated } from "./pattern";
import { candidatesFromEntities, dragSnap, originCandidate, pinOriginPoint, showsSnapMarker, snap, type SnapGuide, type SnapKind, type SnapCandidate } from "./snap";
import type { ResolvedEntity } from "./snap";
import { detectRegions, entityPolyline, rectCorners, rectFromThreePoints } from "./region";
import { AreaBox } from "../viewport/areaBox";
import { Disposer } from "../lib/disposer";
import { allInsideRect, convexTouchesRect, dragBox, isAreaDrag, pointInRect, type AreaMode, type ScreenRect } from "../viewport/areaSelect";
import { faceFocus, loopsFromEdgePolys, planeEdges, type PlaneEdge } from "./faceFootprint";
import { isExactPlaneEdge, meshBodyIds } from "./planeEdgePick";
import { boundaryAnchors, footprintAnchors, loopCentroid } from "./anchors";
import { setPrompt } from "../ui/prompt";
import { tooEdgeOn } from "./planeGraze";
import { toast } from "../ui/toast";
import { contextMenu, dismissContextMenu, type CtxItem } from "../ui/menu";
import { ConstraintTools, CONSTRAINT_TOOLS, type ConstraintHost, type ConstraintOption } from "./constraintTools";
import { PatternFlow, PATTERN_TOOLS, ENTITY_PATTERNS, type PatternHost } from "./patternFlow";
import { DimFlow, type DimHost } from "./dimFlow";
import { ProjectPanel } from "./projectPanel";
import { ProjectFlow, type ProjectHost } from "./projectFlow";
import { ModifyFlow, type ModifyHost, type ModelEdge } from "./modifyFlow";
import type { MoveTarget } from "../features/moveTarget";
import { sketchEntityTarget, type SketchGizmoHost } from "../features/sketchMoveTarget";
import { sketchEscapeAction } from "./escapeLayers";
import { escapeClaimed } from "../ui/escapeClaim";
import { gridReach, gridStep, SketchPlaneGrid, snapLatticeStep } from "./planeGrid";
import { INFER_TOL_DEG, inferLineDirection } from "./inferLine";
import { sketchLockHolds, viewSquareToPlane } from "./sketchView";
import { SnapTag } from "./snapTag";

export type SketchTool =
  | "select"
  | "line"
  | "rectangle"
  | "centerRectangle"
  | "rectangle3"
  | "circle"
  | "circle2"
  | "circle3"
  | "arc"
  | "spline"
  | "bspline"
  | "polygon"
  | "slot"
  | "point"
  | "mirror"
  | "dimension"
  | "trim"
  | "fillet"
  | "chamfer"
  | "move"
  | "copy"
  | "rotate"
  | "scale"
  | "offset"
  | "extend"
  | "break"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "tangent"
  | "coincident"
  | "concentric"
  | "symmetric"
  | "midpoint"
  | "collinear"
  | "fix"
  | "patternRect"
  | "patternCircular"
  | "hexHoles"
  | "honeycomb"
  | "boltCircle"
  | "gridHoles"
  | "text"
  | "project";

// PRESET_PATTERNS/ENTITY_PATTERNS/PATTERN_TOOLS live in patternFlow.ts (imported
// above); CONSTRAINT_TOOLS lives in constraintTools.ts (also imported above).
const MODIFY_TOOLS = new Set<SketchTool>([
  "trim",
  "fillet",
  "chamfer",
  "move",
  "copy",
  "rotate",
  "scale",
  "offset",
  "extend",
  "break",
  "mirror",
  "dimension",
  ...CONSTRAINT_TOOLS,
]);

// Map planegcs conflict ids back to constraint indices. Implicit ids (rect
// edges `<id>~h0`, the drag pin) decode to null and are skipped.
function parseConflictIdx(ids: string[]): Set<number> {
  const s = new Set<number>();
  for (const id of ids) {
    const i = constraintIndexOf(id);
    if (i !== null) s.add(i);
  }
  return s;
}

// Tools that operate on the current multi-selection, so setTool must keep it.
// The entity patterns belong here for the same reason mirror does: they
// replicate what is selected, and clearing it on the way in left them refusing
// with "Select entities first" that no amount of selecting first could answer.
const KEEPS_SELECTION = new Set<SketchTool>(["mirror", "move", "copy", "rotate", "scale", ...ENTITY_PATTERNS]);

// Sentinel id for the in-progress text tool's live-preview entity: it lives on the
// active entity list (so it repaints through the normal render path) but is never
// committed, filtered out at serialization and dropped on tool switch/cancel.
const TEXT_PREVIEW_ID = "__textpreview__";

// A dimmed curve blue: snappable, but never mistaken for drawn geometry.
const FACE_ANCHOR_COLOR = 0x4a6a94;
/** How far mm-per-pixel may drift before the annotation furniture is rebuilt at
 *  the new zoom. See updateAnnotationScale. */
const DIM_SCALE_TOL = 1.05;
/** Outer radius of the snap ring, in screen pixels. The mesh is a unit ring
 *  (overlay.ts), so this doubles as the scale factor per mm-per-pixel. */
const SNAP_MARKER_PX = 6;


export class SketchMode {
  active = false;
  tool: SketchTool = "select";
  /** The body face this sketch is anchored to, when it was drawn on one. */
  private face: { selector: Selector; at: [number, number, number] } | null = null;
  onState: (() => void) | null = null; // notify UI (tool/active changed)
  /** Injected by the engine: the move gizmo, which lives outside sketch mode. */
  gizmo: {
    start(target: MoveTarget, done: () => void): void;
    cancel(): void;
    readonly active: boolean;
  } | null = null;

  private plane = new SketchPlane("XY");

  /** The model's outline on this sketch's plane, in sketch 2D, what makes a

   *  profile that runs off the face split there. Empty on a datum plane. */

  private footprint: THREE.Vector2[][] = [];
  /** The same edges, UN-chained, one polyline each, which is what tells a
   *  corner from a point part way along an arc. See anchors.boundaryAnchors. */
  private footprintEdges: THREE.Vector2[][] = [];
  private viewFocus = new THREE.Vector3();
  /** The exact ones among them, with their source edge, for Offset to take. */
  private modelPlaneEdges: PlaneEdge<ModelEdge>[] = [];
  private entities: ResolvedEntity[] = [];
  private candidates: SnapCandidate[] = []; // cached; rebuilt when entities change
  private base: THREE.Vector2 | null = null; // pending first point
  private chainStart: THREE.Vector2 | null = null; // first point of a line chain
  private arcStart: THREE.Vector2 | null = null; // 3-point arc: start, end, then bulge
  private arcEnd: THREE.Vector2 | null = null;
  private splinePts: THREE.Vector2[] = []; // in-progress spline fit points
  private clickPts: THREE.Vector2[] = []; // accumulated clicks for multi-point primitives (polygon/slot/circle variants)
  private polygonSides = 6; // n for the polygon tool
  private selected = new Set<string>(); // selected entity ids (select tool)
  /** a press on empty space that becomes a selection box once it travels */
  private boxDown: { x: number; y: number; additive: boolean; shift: boolean; base: Set<string>; region: WorldRegion | null } | null = null;
  private areaBox = new AreaBox();
  /** The Relations list in the Sketch Palette. */
  private relations = new RelationsPanel();
  /** Entity ids lit by the relations row under the cursor. Display only: it
   *  never reaches the document, the solver or the undo history. */
  private relHover = new Set<string>();
  private constraints: SketchConstraint[] = []; // persistent constraints (solved)
  private patterns: SketchPattern[] = []; // associative pattern definitions
  private lastDof = -1;
  private dragFrom: THREE.Vector2 | null = null; // grabbed point's current position
  // A grabbed point that never moves past 4px is a click, which selects its entity.
  private dragEntIdx = -1;
  private dragStartClient = { x: 0, y: 0 };
  private dragMoved = false;
  private dragShift = false;
  private dragPole = -1; // the grabbed point's pole index when it is a bspline pole
  private lastPress = { t: 0, x: 0, y: 0 };
  /** The pole last clicked on a selected control-point spline, what Delete removes. */
  private selectedPole: { id: string; k: number } | null = null;
  private dragSnapshot: ResolvedEntity[] | null = null; // entities at drag start (Esc reverts)
  /** What a dragged point can land on, taken at the grab so nothing that moves with it is offered. */
  private dragAnchors: SnapCandidate[] = [];

  // --- in-sketch undo -------------------------------------------------------
  // Per session: the document undo would pop the whole sketch, which is not in
  // the document until finish().
  private history = new SketchHistory();
  private dragRefusedToast = false; // one fixed-point toast per refused drag gesture
  private pendingDrag: { fromX: number; fromY: number; toX: number; toY: number } | null = null;
  // Whole-entity drag, armed on pointerdown but built only once the pointer moves,
  // so a plain click stays a selection.
  private moveDrag: {
    idx: number;
    startClient: { x: number; y: number };
    last: THREE.Vector2;
    started: boolean;
    shift: boolean;
    stretch: ((dx: number, dy: number) => void)[]; // filled when the move starts
    /** a text is grabbed by its letters, and a click on it still picks that letter's area */
    region?: WorldRegion | null;
  } | null = null;
  private solveBusy = false; // a solve is in flight (drag or constraint)
  // the solver WASM failed to come up: stop pumping and say so ONCE, rather
  // than letting every stroke raise the same unhandled rejection
  private solverDead = false;
  private solverDeadToast = false;
  private directDimToast = false; // said once: dims are being written straight to geometry
  private solveDirty = false; // a constraint/dimension solve is pending
  private entityVersion = 0; // bumped on every entity change; guards stale solves
  private conflict = false; // last solve reported conflicting (over-)constraints
  private lastCursor = new THREE.Vector2();
  // right-press bookkeeping for the canvas context menus: a right-DRAG is a
  // camera pan and must not pop a menu on release (the viewport applies the
  // same 5 px rule to its own right-click menus).
  private rightDownAt: { x: number; y: number } | null = null;
  private rightDragged = false;
  // Move/Copy tool: first (base) point picked; the second click sets the offset.
  // distance-constraint dims, computed once per refreshActive() in activeCurves()
  // and reused for the clickable labels (constraintDimExtras)
  private cdims: ConstraintDim[] = [];
  private editingId: string | null = null;
  get editingSketchId(): string | null {
    return this.editingId;
  }
  /** The datumPlane feature this sketch is placed ON, when it was created from
   *  one. Round-tripped through finish() so re-editing a sketch never silently
   *  downgrades it from a live datum link to a baked placement. */
  private planeId: string | null = null;
  private store: DocumentStore | undefined;
  private grid: SketchPlaneGrid | null = null;
  /** Scratch for updateGrid(), so the per-frame path allocates nothing. */
  private gridFocus = new THREE.Vector2();
  private gridTarget = new THREE.Vector3();
  /** Scratch for planeMmPerPx(), which runs on the same per-frame path. */
  private scaleAt = new THREE.Vector3();
  private scaleAt2 = new THREE.Vector2();
  // Sketch Palette options
  private gridVisible = true;
  private gridSnap = true;
  private constructionMode = false;
  private referenceMode = false; // dimensions placed as driven/reference (measured only)
  private dimsVisible = true;
  private glyphsVisible = true; // show constraint glyphs on canvas
  // Glyph and conflict indices are positional into this.constraints; every mutation
  // is followed by refreshActive(), which re-indexes before the next input frame.
  private conflictIdx = new Set<number>(); // constraint indices the solver flagged conflicting
  private overIdx = new Set<number>(); // indices flagged redundant / over-defining (removable)
  private readonly textPanel = new TextPanel();
  // Project tool: filter chips (edges&faces / sketch curves) + a one-at-a-time
  // in-flight gate so a double-click can't race two projectGeometry calls.
  private readonly projectPanel = new ProjectPanel();
  private fonts: string[] = []; // system fonts for the text tool (loaded on enter)
  // text tool: press-drag defines a box (wrap width); a plain click is a point anchor.
  private textBoxStart: THREE.Vector2 | null = null;
  private textBoxEnd: THREE.Vector2 | null = null;
  private textBoxScreen: { x: number; y: number } | null = null;
  private viewLocked = false; // the palette's "Lock to Plane" preference (off by default)
  // --- the sketch view's soft lock -------------------------------------------
  // "Lock to Plane" lets go once you zoom out past the framing the sketch opened at
  // (sketchView.sketchLockHolds). Placement raycasts onto the plane at any angle.
  /** View half-height once the entry flight has landed. */
  private entryScale: number | null = null;
  private lockReleased = false;
  private releaseAnnounced = false; // say it once per session, not once per frame
  // The view direction/up from just before entering, and whether the user
  // orbited during the session. enterSketchView forces the camera square onto
  // the plane and nothing ever turns it back afterwards, so a sketch drawn
  // without touching the camera left it pinned there for good: Fit View can
  // still frame the model, but only from that flat, close-up angle, which
  // reads as broken. Restored on a normal exit, unless the user orbited their
  // own way out already (an explicit choice, not left for us to override).
  private preSketchDir: THREE.Vector3 | null = null;
  private preSketchUp: THREE.Vector3 | null = null;
  private navigatedDuringSketch = false;
  private unsubInputStart: (() => void) | null = null;
  private raf = 0;
  private dim: DimInput;
  private dims: SketchDimensions;
  private glyphs: SketchGlyphs;
  /** Everything one open sketch attaches, released together when it closes. */
  private session = new Disposer();
  private boundDown: (e: PointerEvent) => void;
  private boundMove: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;
  private boundContext: (e: MouseEvent) => void;
  private boundLeave: () => void;
  private boundTick: () => void;
  // collaborators: the constraint-tool click flows and the pattern placement/edit
  // flow, each operating on a live accessor into this SketchMode (see their
  // Host interfaces) rather than a copy of its state.
  private constraintTools: ConstraintTools;
  private patternFlow: PatternFlow;
  private dimFlow: DimFlow;
  private projectFlow: ProjectFlow;
  private modifyFlow: ModifyFlow;

  constructor(
    private viewport: Viewport,
    private overlay: SketchOverlay,
  ) {
    this.dim = new DimInput();
    this.dims = new SketchDimensions(
      viewport,
      (i, f, mm) => this.editDimension(i, f, mm),
      (i, f, raw) => this.commitEntityDimExpr(i, f, raw),
      (i, f) => this.entityDimExpr(i, f),
    );
    this.dims.onOverlapPick = (e) => this.labelOverlapSelect(e);
    this.dims.onPlanePoint = (cx, cy) => this.planePointAt(cx, cy);
    this.dims.onEntityPlace = (i, f, ox, oy, done) => this.commitEntityPlace(i, f, ox, oy, done);
    this.dims.onLabelMenu = (e, del) => {
      // Disabled rather than absent on an entity dim: a circle's diameter is a
      // property of the circle, so there is no constraint to remove, and saying
      // so is preferred over a right-click that appears to do nothing.
      contextMenu(e.clientX, e.clientY, [
        { label: "Delete dimension", danger: true, disabled: !del, shortcut: "Del", onClick: () => del?.() },
      ]);
    };
    this.glyphs = new SketchGlyphs(viewport);
    this.glyphs.onDelete = (i) => this.deleteConstraint(i);
    this.glyphs.onEditPattern = (id) => this.editPattern(id);
    this.glyphs.onOverlapPick = (e) => this.labelOverlapSelect(e);
    this.relations.onDelete = (i) => this.deleteConstraint(i);
    this.relations.onHover = (ids) => this.setRelationHover(ids);
    this.relations.onSelect = (ids) => this.selectFromRelation(ids);
    this.boundDown = (e) => this.onPointerDown(e);
    this.boundMove = (e) => this.onPointerMove(e);
    this.boundUp = (e) => this.endDrag(e.pointerId);
    this.boundKey = (e) => this.onKey(e);
    this.boundContext = (e) => this.onContextMenu(e);
    // A snap marker is a statement about where the CURSOR is. With the cursor
    // off the canvas there is no such place, and one left standing where the
    // pointer happened to exit reads as a mark on the drawing.
    this.boundLeave = () => this.showSnap(null);
    this.boundTick = () => this.tick();
    const constraintHost: ConstraintHost = {
      tool: () => this.tool,
      entities: () => this.entities,
      constraints: () => this.constraints,
      pickTol: () => this.pickTol(),
      getFilletFirst: () => this.modifyFlow.getFilletFirst(),
      setFilletFirst: (v) => { this.modifyFlow.setFilletFirst(v); },
      requestSolve: () => this.requestSolve(),
      warn: (msg) => toast(msg),
    };
    this.constraintTools = new ConstraintTools(constraintHost);
    const patternHost: PatternHost = {
      tool: () => this.tool,
      setActiveTool: (t) => { this.tool = t; },
      setTool: (t) => this.setTool(t),
      selected: () => this.selected,
      patterns: () => this.patterns,
      dim: () => this.dim,
      sourcePoint: (id) => {
        const ent = this.entities.find((x) => x.id === id);
        return ent ? loopCentroid(entityPolyline(ent)) : null;
      },
      requestSolve: () => this.requestSolve(),
      toScreen: (x, y) => {
        const s = this.viewport.projectToScreen(this.plane.to3D(x, y));
        return Number.isFinite(s.x) && Number.isFinite(s.y) ? s : null;
      },
      showCentreDot: (p) => {
        this.overlay.setHandleDot(p ? this.plane.to3D(p.x, p.y) : null);
        this.viewport.requestRender();
      },
      refreshActive: () => this.refreshActive(),
      onState: () => this.onState?.(),
    };
    this.patternFlow = new PatternFlow(patternHost);
    const dimHost: DimHost = {
      entities: () => this.entities,
      constraints: () => this.constraints,
      dim: () => this.dim,
      overlay: () => this.overlay,
      viewport: () => this.viewport,
      plane: () => this.plane,
      lastCursor: () => this.lastCursor,
      referenceMode: () => this.referenceMode,
      pickTol: () => this.pickTol(),
      planeMmPerPx: () => this.planeMmPerPx(),
      planePoint: (e) => this.planePoint(e),
      textEntityAt: (pt) => this.textEntityAt(pt),
      evalDimInput: (raw, kind, key) => this.evalDimInput(raw, kind, key),
      recordBinding: (key, r, kind) => this.recordBinding(key, r, kind),
      placeDim: (c, forceDriven) => this.placeDim(c, forceDriven),
      onState: () => this.onState?.(),
    };
    this.dimFlow = new DimFlow(dimHost);
    const projectHost: ProjectHost = {
      entities: () => this.entities,
      store: () => this.store,
      overlay: () => this.overlay,
      viewport: () => this.viewport,
      plane: () => this.plane,
      projectPanel: () => this.projectPanel,
      editingId: () => this.editingId,
      active: () => this.active,
      tool: () => this.tool,
      pickTol: () => this.pickTol(),
      planePoint: (e) => this.planePoint(e),
      refreshActive: () => this.refreshActive(),
      requestSolve: () => this.requestSolve(),
      onState: () => this.onState?.(),
    };
    this.projectFlow = new ProjectFlow(projectHost);
    const modifyHost: ModifyHost = {
      entities: () => this.entities,
      setEntities: (list) => { this.entities = list; },
      selected: () => this.selected,
      setSelected: (ids) => { this.selected = ids; },
      dim: () => this.dim,
      overlay: () => this.overlay,
      plane: () => this.plane,
      tool: () => this.tool,
      pickTol: () => this.pickTol(),
      planePoint: (e) => this.planePoint(e),
      afterModify: () => this.afterModify(),
      setDrivingDimension: (c) => this.setDrivingDimension(c),
      planeEdges: () => this.modelPlaneEdges,
      projectModelEdges: (edges) => this.projectFlow.projectModelEdges(edges),
      emphasiseModelEdges: (edges) => this.viewport.emphasiseEdges(edges),
    };
    this.modifyFlow = new ModifyFlow(modifyHost);
    // Filter chip clicks land on the panel, not the canvas, so projectHover
    // doesn't run, clear the other mode's hover feedback explicitly.
    this.projectPanel.onChange = () => {
      this.viewport.hoverEntity(null);
      this.overlay.setPreview([]);
      this.viewport.requestRender();
    };
  }

  // --- lifecycle ---------------------------------------------------------
  /** `planeId` links the sketch to a datum plane so it moves with the datum; `plane`
   *  stays as the resolved cache every frontend reader uses. */
  enter(
    plane: PlaneSpec,
    store: DocumentStore,
    editId?: string,
    planeId?: string,
    face?: { selector: Selector; at: [number, number, number] } | null,
  ) {
    this.active = true;
    this.editingId = editId ?? null;
    this.plane = this.overlay.planeFor(plane);
    this.planeId = planeId ?? null;
    // The face this sketch is drawn on, so the engine can re-derive the plane
    // every rebuild instead of the sketch recording where the face used to be.
    // A sketch on a base plane or on a datum has none, and neither needs one.
    this.face = face ?? null;
    this.store = store;
    // Once per session: the body under an open sketch cannot change.
    const inPlane = planeEdges(
      this.viewport.visibleEdgeLines(),
      this.plane,
      this.viewport.modelDiagonal() ?? 0,
    );
    this.footprintEdges = inPlane.map((x) => x.poly);
    this.footprint = loopsFromEdgePolys(this.footprintEdges);
    const meshBodies = inPlane.length ? meshBodyIds(store.buildState.result?.bodies, store.document.features) : new Set<string>();
    this.modelPlaneEdges = inPlane.flatMap(({ edge, poly }) =>
      edge.body && isExactPlaneEdge(edge, meshBodies) ? [{ edge: { body: edge.body, points: edge.points }, poly }] : []);
    this.history.reset(); // fresh history per session (armed once entities load)
    if (!this.fonts.length) void fetchFonts().then((f) => { this.fonts = f; });

    // load existing entities if editing
    this.entities = [];
    this.constraints = [];
    this.patterns = [];
    this.patternFlow.resetForEnter();
    this.selected.clear();
    this.overlay.clearRegionSelection(); // fresh session: drop any stale area selection
    this.lastDof = -1;
    this.conflict = false;
    if (editId) {
      const f = store.document.features.find((x) => x.id === editId);
      const sk = asFeature(f, "sketch");
      if (sk) {
        // real entities only, derived pattern copies are NEVER stored in
        // this.entities (see derivedEntities()); doing so would persist them
        // as real geometry on the next finish() and bake in duplicates (§1.2).
        this.entities = resolveRealEntities(sk, store.document.parameters);
        this.constraints = sk.constraints ? sk.constraints.map((c) => ({ ...c })) : [];
        this.patterns = sk.patterns ? sk.patterns.map((p) => ({ ...p })) : [];
        // keep an existing datum link across a re-edit (the caller only passes
        // planeId when it just created the datum)
        if (sk.planeId) this.planeId = sk.planeId;
        // ...and the same for the face anchor: re-editing a sketch must not
        // strip the reference that makes it follow. The caller passes one only
        // when the sketch is being CREATED on a face.
        if (sk.face) {
          this.face = { selector: sk.face, at: (sk.at ?? [0, 0, 0]) as [number, number, number] };
        }
        for (const p of this.patterns) notePatternId(p.id); // reserve ids so new ones don't collide
      }
    }

    this.viewport.suspendPicking = true;
    this.viewFocus = this.focusPoint();
    // viewDirection() is the camera's look-along (eye toward target); setViewDir's
    // `dir` is the opposite, eye = target + dir·d (see applyOverride's face normal
    // for the same convention), so it has to be negated here or the restore below
    // lands the camera on the far side of the model, upside-down-ish from where it
    // was (round 2's PM-6: nav cube read BOTTOM after a plain sketch+extrude).
    this.preSketchDir = this.viewport.rig.viewDirection(new THREE.Vector3()).negate();
    this.preSketchUp = new THREE.Vector3().setFromMatrixColumn(this.viewport.rig.active.matrixWorld, 1);
    this.navigatedDuringSketch = false;
    this.viewport.enterSketchView(this.viewFocus, this.plane.n, this.plane.v);
    this.entryScale = null; // re-baselined on the first tick, once the camera lands
    this.lockReleased = false;
    this.releaseAnnounced = false;
    this.gridFocus.set(0, 0); // scratch; updateGrid() writes the camera target into it
    this.addGrid();
    if (!this.raf) this.raf = requestAnimationFrame(this.boundTick);

    this.session.dispose();
    const session = (this.session = new Disposer());
    const el = this.viewport.domElement;
    session.listen(el, "pointerdown", this.boundDown);
    session.listen(el, "pointermove", this.boundMove);
    session.listen(el, "pointerup", this.boundUp);
    session.listen(el, "contextmenu", this.boundContext);
    session.listen(el, "pointerleave", this.boundLeave);
    session.listen(window, "keydown", this.boundKey, true);
    session.add(() => {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    });
    this.unsubInputStart = this.viewport.rig.onInputStart(() => { this.navigatedDuringSketch = true; });
    session.add(() => { this.unsubInputStart?.(); this.unsubInputStart = null; });

    this.overlay.update(store.document, this.editingId ?? "__active__");
    this.refreshActive();
    this.armPreEdit(); // the session's baseline: the first edit undoes back to here
    this.setTool("rectangle");
    this.setViewLocked(this.viewLocked); // apply lock-to-plane preference
    if (this.constraints.length > 0) this.requestSolve(); // restore DOF state
    this.onState?.();
  }

  /** The feature this session would commit, for the bug reporter: the store has no
   *  copy until finish(). Shared with finish(). Null when nothing is drawn. */
  snapshotFeature(): Feature | null {
    if (!this.active || !this.store) return null;
    if (this.entities.length === 0 && this.patterns.length === 0) return null;
    return {
      id: this.editingId ?? this.store.nextId(),
      type: "sketch",
      plane: this.plane.serialize(),
      ...(this.planeId ? { planeId: this.planeId } : {}),
      ...(this.face ? { face: this.face.selector, at: this.face.at } : {}),
      entities: this.entities.filter((e) => e.id !== TEXT_PREVIEW_ID).map(toSketchEntity),
      ...(this.constraints.length > 0 ? { constraints: this.constraints.map((c) => ({ ...c })) } : {}),
      ...(this.patterns.length > 0 ? { patterns: this.patterns.map((p) => ({ ...p })) } : {}),
    };
  }

  /** Whether the camera looks straight at the plane, told on change so the UI can
   *  offer to square it again only when it is not. */
  onViewSquare: ((square: boolean) => void) | null = null;
  private viewSquare = true;

  /** A finished session wrote this sketch to the document. */
  onCommitted: ((id: string) => void) | null = null;

  finish(commit = true) {
    if (!this.active) return;
    if (this.gizmo?.active) this.gizmo.cancel();
    const store = this.store!;
    this.modifyFlow.reset(); // an offset left mid-placement takes its face-edge projection with it
    this.patternFlow.flushOnFinish(); // may add patterns, must precede the snapshot
    const sketch = commit ? this.snapshotFeature() : null;
    if (sketch) {
      if (this.editingId) {
        store.replaceFeature(this.editingId, sketch, this.drainBindings(sketch.id));
      } else {
        store.addFeature(sketch, undefined, this.drainBindings(sketch.id));
        // Only on creation: an edit rebuilds the Divide already after the sketch.
        this.maybeDivideFace(sketch);
      }
    }
    this.cleanup();
    if (sketch) this.onCommitted?.(sketch.id);
  }

  /** Append a Divide Face when the sketch sits on a body face and its curves close
   *  no area of their own (a "+", a line across). Call before cleanup(). */
  private maybeDivideFace(sketch: Feature) {
    if (sketch.type !== "sketch" || !this.face || !this.store) return;
    const ents = [...this.entities, ...this.derivedEntities()];
    const hasEdge = ents.some(
      (e) => !e.construction && e.type !== "point" && e.type !== "text",
    );
    if (!hasEdge) return;
    // With NO footprint, so the question is whether the CURVES close an area,
    // not whether they carve up the face they lie on (they do, and that is the
    // whole point). A profile closes one here; an open cut closes none.
    if (detectRegions(sketch.id, ents, undefined).length > 0) return;
    this.store.addFeature({ id: this.store.nextId(), type: "imprint", sketch: sketch.id });
  }

  cancel() {
    if (this.gizmo?.active) this.gizmo.cancel();
    this.cleanup();
  }

  private cleanup() {
    this.pendingBindings.clear();
    this.session.dispose();
    dismissContextMenu();
    this.selected.clear();
    this.dragFrom = null;
    this.dragSnapshot = null;
    this.pendingDrag = null;
    this.moveDrag = null;
    this.cancelBox();
    this.dim.hide();
    this.dims.hide();
    this.glyphs.hide();
    this.relations.hide();
    this.relHover.clear();
    this.textPanel.hide();
    this.projectPanel.hide();
    setPrompt(null);
    this.viewport.hoverEntity(null); // drop any Project-tool 3D hover highlight
    this.modifyFlow.reset();
    this.overlay.setPreview([]);
    this.overlay.setSnap(null);
    this.snapTag.hide();
    this.overlay.setHandleDot(null);
    this.snapWorld = null;
    this.removeGrid();
    this.viewport.exitSketchView();
    // The camera is still exactly square-on to the plane enterSketchView put it
    // on: turn back to how it looked before, unless the user already orbited
    // their own way out (an explicit choice we leave alone). Direction only,
    // turnTo keeps the current scale/target, so this doesn't fight a zoom.
    if (!this.navigatedDuringSketch && this.preSketchDir) {
      this.viewport.rig.setViewDir(this.preSketchDir, this.preSketchUp ?? new THREE.Vector3(0, 1, 0));
    }
    this.preSketchDir = null;
    this.preSketchUp = null;
    this.viewport.rig.setOrbitLocked(false); // restore free orbit in model mode
    this.viewport.suspendPicking = false;
    this.active = false;
    if (!this.viewSquare) { this.viewSquare = true; this.onViewSquare?.(true); }
    this.base = null;
    this.chainStart = null;
    this.arcStart = null;
    this.arcEnd = null;
    this.splinePts = [];
    this.clickPts = [];
    this.dimFlow.resetDimPicks();
    this.constraintTools.resetPending();
    this.tool = "select";
    this.overlay.setActiveSketch([]); // clear in-progress curves (else they orphan on screen)
    this.overlay.setActiveRegions([], this.plane); // drop active-sketch fills (committed ones re-render)
    if (this.store) this.overlay.update(this.store.document);
    this.onState?.();
  }

  // --- tools -------------------------------------------------------------
  setTool(t: SketchTool) {
    if (this.gizmo?.active) this.gizmo.cancel();
    // With something selected, move, rotate and scale are one gizmo on it; the
    // click flows below are what they fall back to with nothing selected.
    if ((t === "move" || t === "rotate" || t === "scale") && this.active && this.gizmo) this.adoptSelectedText();
    if ((t === "move" || t === "rotate" || t === "scale") && this.active && this.gizmo && this.selected.size) {
      const target = sketchEntityTarget(this.gizmoHost());
      if (target) {
        this.gizmo.start(target, () => this.onState?.());
        return;
      }
    }
    const keepSelection = KEEPS_SELECTION.has(t);
    // Read the selection BEFORE the clear below consumes it: arriving at the
    // dimension tool with geometry already selected dimensions that geometry
    // (Fusion: pick the line, then press D).
    const preselected = t === "dimension" ? [...this.selected] : [];
    this.tool = t;
    this.base = null;
    this.chainStart = null;
    this.arcStart = null;
    this.arcEnd = null;
    this.splinePts = [];
    this.dragFrom = null;
    this.pendingDrag = null;
    this.moveDrag = null;
    this.cancelBox();
    this.dimFlow.resetDimPicks();
    this.modifyFlow.reset(); // an in-progress fillet/move/offset dies with its tool
    this.dim.hide();
    this.textPanel.hide();
    // Project tool: chips only while it's active; leaving it drops any 3D hover
    if (t === "project") this.projectPanel.show(this.viewport.domElement);
    else {
      this.projectPanel.hide();
      this.viewport.hoverEntity(null);
    }
    // drop any uncommitted text preview left on the active list when switching tools
    if (this.dropTextPreview()) this.refreshActive();
    this.overlay.setPreview([]);
    this.constraintTools.resetPending();
    if (!keepSelection && this.selected.size) { this.selected.clear(); this.refreshActive(); }
    if (preselected.length) this.dimFlow.seedDimPicks(preselected);
    this.patternFlow.flushPending(); // don't lose an in-progress pattern
    if (t === "patternCircular" && this.active && this.selected.size) {
      for (const id of this.modifyFlow.warnSelectedProjected()) this.selected.delete(id);
      this.patternFlow.begin();
    } else if (ENTITY_PATTERNS.has(t) && this.active && !this.selected.size) {
      setPrompt("Click the curves or profile to pattern");
    }
    // Live in `dimension` too: that tool re-arms after each commit, so users stayed in
    // it and could not edit what they had just dimensioned.
    const annotationsLive = t === "select" || t === "dimension";
    this.dims.setInteractive(annotationsLive);
    this.glyphs.setInteractive(annotationsLive);
    this.onState?.();
  }

  /** Text is picked through its glyph areas, so a text selected that way is the
   *  text entity as far as a transform is concerned. */
  private adoptSelectedText() {
    const ids = this.overlay.selectedActiveTextIds();
    if (!ids.length) return;
    for (const id of ids) this.selected.add(id);
    this.overlay.clearRegionSelection();
    this.refreshActive();
  }

  private cancelBox() {
    this.boxDown = null;
    this.areaBox.hide();
  }

  private selectInBox(rect: ScreenRect, mode: AreaMode, base: Set<string>) {
    const next = new Set(base);
    const screen = (p: THREE.Vector2) => {
      const s = this.viewport.projectToScreen(this.plane.to3D(p.x, p.y));
      return [s.x, s.y];
    };
    const touches = (pts: number[]) => {
      if (pts.length === 2) return pointInRect(pts[0]!, pts[1]!, rect);
      for (let i = 0; i + 3 < pts.length; i += 2) {
        if (convexTouchesRect(pts.slice(i, i + 4), rect)) return true;
      }
      return false;
    };
    for (const e of this.entities) {
      if (e.id === TEXT_PREVIEW_ID) continue;
      const loops = e.type === "text" ? this.overlay.activeTextLoops(e.id) : [entityPolyline(e)];
      const shapes = loops.map((l) => l.flatMap(screen)).filter((pts) => pts.length);
      if (!shapes.length) continue;
      const hit = mode === "window"
        ? shapes.every((pts) => allInsideRect(pts, rect))
        : shapes.some((pts) => touches(e.type === "text" ? [...pts, pts[0]!, pts[1]!] : pts));
      if (hit) next.add(e.id);
    }
    const same = next.size === this.selected.size && [...next].every((id) => this.selected.has(id));
    if (same) return;
    this.selected = next;
    this.refreshActive();
  }

  private gizmoHost(): SketchGizmoHost {
    return {
      plane: () => this.plane,
      selection: () => this.entities.filter((e) => this.selected.has(e.id) && e.type !== "projected"),
      showPreview: (ents) =>
        this.overlay.setPreview(ents ? curveObjects(ents, this.plane, PREVIEW_COLOR, true) : []),
      apply: (map, copy) => this.modifyFlow.applyTransform(map, copy),
      outline: (e) => this.overlay.activeTextLoops(e.id).flat(),
    };
  }

  /** Public re-draw hook: e.g. async glyph outlines for a text entity just arrived,
   *  so the active sketch's curves (incl. text + its live preview entity) need
   *  repainting. No-op when inactive. */
  redraw(): void {
    if (this.active) this.refreshActive();
  }

  /** Rebuild the active sketch's committed curves + snap candidates + editable
   * dimension labels. Called when the entity list changes, and on drag end. */
  private refreshActive() {
    this.entityVersion++; // bump guards in-flight constraint solves against staleness
    // current zoom → mm-per-pixel, so dimension badges keep screen clearance
    // from the geometry they label (they're click targets in the select tool)
    setDimPixelScale(this.planeMmPerPx());
    const derived = this.derivedEntities(); // computed once, shared below
    this.overlay.setActiveSketch(this.activeCurves(derived));
    // profile-area fills for the active sketch (hidden from overlay.update),
    // so areas are visible + selectable while drawing
    this.overlay.setActiveRegions(
      detectRegions(
        this.editingId ?? "__active__",
        [...this.entities, ...derived],
        // Empty means "no model in this plane", a datum-plane sketch, and must
        // reach detectRegions as absent, not as an empty face, or every profile
        // there would be marked unsupported.
        this.footprint.length ? this.footprint : undefined,
      ),
      this.plane,
      this.editingId ?? "__active__",
      [...this.entities, ...derived],
    );
    this.candidates = [
      ...candidatesFromEntities([...this.entities, ...derived]),
      ...this.faceAnchorCandidates(),
      ...originCandidate(this.plane),
    ];
    // an in-progress dimension holds entity REFERENCES, and a solve replaces
    // every entity object, re-read the picks off the fresh list
    if (this.dimFlow.picking) this.dimFlow.refreshDimPlan();
    if (this.dimsVisible) this.dims.show(this.entities, this.plane, this.constraintDimExtras());
    else this.dims.hide();
    if (this.glyphsVisible) this.glyphs.show(this.allGlyphs(), this.plane, this.conflictIdx, this.overIdx);
    else this.glyphs.hide();
    // The list, from the same four inputs the badges take. refreshActive is the
    // choke point every constraint change and every finished solve passes
    // through, which is why it goes here rather than at each of those sites.
    this.relations.show(
      this.entities, this.constraints, this.conflictIdx, this.overIdx,
      this.lastDof, this.conflict,
    );
    // On-demand renderer: a keyboard-driven repaint (e.g. async text glyphs landing
    // via redraw()) fires no pointer event, so force a frame or it won't draw until
    // the next mouse move.
    this.viewport.requestRender();
  }

  private allGlyphs() {
    const pending = this.patternFlow.pending;
    const patterns = pending ? this.patterns.filter((p) => p.id !== pending.id) : this.patterns;
    return [
      ...constraintGlyphs(this.entities, this.constraints),
      ...patternGlyphs(patterns, (id) => {
        const ent = this.entities.find((x) => x.id === id);
        return ent ? loopCentroid(entityPolyline(ent)) : null;
      }),
    ];
  }

  /** Lightweight per-frame refresh for dragging: the curves and constraint glyphs
   * move, the snap-candidate array (a drag snaps to dragAnchors) and the
   * dimension labels wait for refreshActive() on end. */
  private refreshDragGeometry() {
    this.entityVersion++;
    this.overlay.setActiveSketch([...curveObjects(this.entities, this.plane, this.activeColor()), ...this.polygonObjects()]);
    // Glyphs are a store push the layer projects anyway, so they ride along with the drag.
    if (this.glyphsVisible) this.glyphs.show(this.allGlyphs(), this.plane, this.conflictIdx, this.overIdx);
  }

  // --- per-frame reconcile (grid + view lock) --------------------------------
  /** Follow the camera once a frame (zoom arrives from four input paths): the grid,
   *  and how far the view has drifted from the plane. */
  private tick() {
    this.raf = requestAnimationFrame(this.boundTick);
    if (!this.active) return;
    const scale = this.viewport.rig.viewScale();
    if (this.entryScale == null) {
      // Baseline only after the entry flight lands.
      if (this.viewport.rig.isFlying()) return;
      this.entryScale = scale;
      return;
    }
    this.updateGrid();
    this.updateAnnotationScale();
    this.updateSnapScale();
    const square = !this.viewport.rig.isFlying()
      && viewSquareToPlane(this.viewDir(), this.plane.n.toArray() as [number, number, number]);
    if (square !== this.viewSquare) {
      this.viewSquare = square;
      this.onViewSquare?.(square);
    }
    if (this.lockReleased) return;
    // Locked: zooming out releases. Unlocked: turning away does.
    const drifted = this.viewLocked
      ? !sketchLockHolds(this.entryScale, scale)
      : !viewSquareToPlane(this.viewDir(), this.plane.n.toArray() as [number, number, number]);
    if (drifted) this.releaseView();
  }

  private viewDirScratch = new THREE.Vector3();
  /** Which way the camera is pointing, as a plain tuple for sketchView. */
  private viewDir(): [number, number, number] {
    const d = this.viewport.rig.viewDirection(this.viewDirScratch);
    return [d.x, d.y, d.z];
  }

  private focusPoint(): THREE.Vector3 {
    const at = this.face?.at;
    if (!at) return this.plane.origin.clone();
    const at2 = this.plane.to2D(new THREE.Vector3(at[0], at[1], at[2]));
    const c = faceFocus(this.footprint, at2) ?? at2;
    return this.plane.to3D(c.x, c.y);
  }

  /** Hand the camera back: orbit on, and the projection from before the sketch. */
  private releaseView() {
    const wasLocked = this.viewLocked;
    this.lockReleased = true;
    this.viewport.rig.setOrbitLocked(false);
    this.viewport.setSketchFlat(false);
    // Only ANNOUNCE a release when something was actually holding the view. With
    // the lock off, the default, turning away is the ordinary thing to do and
    // being told about it every time would be noise.
    if (!wasLocked || this.releaseAnnounced) return;
    this.releaseAnnounced = true;
    toast("View unlocked. Drawing still lands on the sketch plane; Look At re-squares it.");
  }

  /** Re-arm the lock and re-baseline it. Called by anything that deliberately
   *  puts the camera back on the plane, so a released session can be recovered
   *  without leaving and re-entering the sketch. */
  private squareToPlane() {
    this.viewport.enterSketchView(this.viewFocus, this.plane.n, this.plane.v);
    this.lockReleased = false;
    this.entryScale = null; // re-measured on the next tick, from the new framing
  }

  /** Dimension arrowheads are screen sizes baked into world geometry (entityDims.px),
   *  so they rebuild when zoom changes mm-per-pixel by 5%, about once per notch. */
  private dimScaleSeen = 0;
  private updateAnnotationScale() {
    const mmPerPx = this.planeMmPerPx();
    if (!(mmPerPx > 0) || !Number.isFinite(mmPerPx)) return;
    const last = this.dimScaleSeen;
    if (last > 0 && mmPerPx > last / DIM_SCALE_TOL && mmPerPx < last * DIM_SCALE_TOL) return;
    this.dimScaleSeen = mmPerPx;
    setDimPixelScale(mmPerPx);
    // Deliberately NOT refreshActive(): that bumps entityVersion (cancelling any
    // in-flight constraint solve) and re-derives regions and snap candidates,
    // none of which depend on the zoom. Only the annotation geometry does.
    this.overlay.setActiveSketch(this.activeCurves(this.derivedEntities()));
    if (this.dimsVisible) this.dims.show(this.entities, this.plane, this.constraintDimExtras());
    this.viewport.requestRender();
  }

  /** mm per screen pixel at the camera target on the plane. Not at the plane origin:
   *  in perspective the answer depends on the point, and was 2x wrong off-origin. */
  private planeMmPerPx(): number {
    const at = this.plane.to2D(this.viewport.cameraTarget(this.scaleAt), this.scaleAt2);
    const mm = this.viewport.pixelWorldSize(this.plane.to3D(at.x, at.y, this.scaleAt));
    // A camera target behind the eye, or a degenerate frustum, would poison
    // every size on screen. The origin is the fallback it used to be.
    return mm > 0 && Number.isFinite(mm) ? mm : this.viewport.pixelWorldSize(this.plane.origin);
  }

  private updateGrid() {
    const mmPerPx = this.planeMmPerPx();
    // The drawn spacing, not snapLatticeStep, which stops at MIN_SNAP_STEP.
    this.viewport.reportGridStep(gridStep(mmPerPx, 0));
    const grid = this.grid;
    if (!grid || !this.gridVisible) return;
    // Built around the camera target so the grid follows a pan.
    const focus = this.plane.to2D(this.viewport.cameraTarget(this.gridTarget), this.gridFocus);
    // Floored at the snap step so every drawn line is a line the cursor catches
    // on; free to go finer when snapping is off (see planeGrid.gridStep).
    const rebuilt = grid.update(
      this.plane,
      focus.x,
      focus.y,
      mmPerPx,
      gridReach(mmPerPx, this.viewport.viewDiagonalPx()),
      0, // no floor: the snap lattice follows the drawn one now, not the reverse
    );
    if (rebuilt) this.viewport.requestRender();
  }

  // --- Sketch Palette options ---
  setGridVisible(on: boolean) {
    this.gridVisible = on;
    this.grid?.setVisible(on);
    this.viewport.requestRender();
  }
  setGridSnap(on: boolean) {
    this.gridSnap = on;
  }
  setConstruction(on: boolean) {
    this.constructionMode = on;
  }
  setReferenceDim(on: boolean) {
    this.referenceMode = on;
  }
  /** Place a dimension, driven (reference) when the palette says so or every operand
   *  is fixed geometry. Returns the placed constraint so a caller can bind to it. */
  private placeDim(c: SketchConstraint, forceDriven = false): SketchConstraint {
    const drivenable = isPlacedDim(c);
    const driven = drivenable && (this.referenceMode || forceDriven);
    if (this.referenceMode && !drivenable) {
      toast("Lengths and diameters can't be reference dimensions yet, made this one driving");
    }
    // Said out loud, or it reads as the Reference toggle being ignored.
    if (driven && forceDriven && !this.referenceMode) {
      toast("Both sides are projected geometry and can't move, so this is a reference dimension");
    }
    const out = driven ? ({ ...c, driven: true } as SketchConstraint) : c;
    this.setDrivingDimension(out);
    return out;
  }
  setDimensionsVisible(on: boolean) {
    this.dimsVisible = on;
    this.refreshActive(); // toggles both the dimension lines and the value labels
  }
  setConstraintsVisible(on: boolean) {
    this.glyphsVisible = on;
    this.relations.setVisible(on);
    this.refreshActive();
  }

  /** Light the geometry a relations row names. Curves only: refreshActive() would
   *  cancel an in-flight solve. */
  private setRelationHover(ids: string[] | null) {
    const next = new Set(ids ?? []);
    if (next.size === this.relHover.size && [...next].every((id) => this.relHover.has(id))) return;
    this.relHover = next;
    this.overlay.setActiveSketch(this.activeCurves(this.derivedEntities()));
    this.viewport.requestRender();
  }

  /** Arms select first, since setTool clears the selection. */
  private selectFromRelation(ids: string[]) {
    if (this.tool !== "select") this.setTool("select");
    this.selected = new Set(ids.filter((id) => this.entities.some((e) => e.id === id)));
    this.refreshActive();
    this.onState?.();
  }
  /** Delete the constraint at `cIndex` (clicked its glyph) and re-solve. */
  private deleteConstraint(cIndex: number) {
    if (cIndex < 0 || cIndex >= this.constraints.length) return;
    this.constraints.splice(cIndex, 1);
    this.conflictIdx.clear(); // indices shift; the next solve repopulates
    this.overIdx.clear();
    this.requestSolve();
    this.refreshActive();
    this.onState?.();
  }
  /** Lock the camera square to the sketch plane: re-square now and disable orbit
   *  (mouse + SpaceMouse) so the view can't tilt off the plane. Unlock = free orbit. */
  setViewLocked(on: boolean) {
    this.viewLocked = on;
    // Through squareToPlane, not enterSketchView: re-locking has to re-baseline
    // the release check too, or a session the zoom already released would come
    // back square with the lock still disarmed and drift straight off again.
    if (on) this.squareToPlane();
    this.viewport.rig.setOrbitLocked(on);
  }
  /** re-square the camera to the active sketch plane (palette "Look At").
   *  This is the recovery the release toast points at, so it re-arms the lock
   *  rather than only moving the camera. */
  lookAt() {
    this.squareToPlane();
    if (this.viewLocked) {
      this.viewport.rig.setOrbitLocked(true);
    }
    // Flat comes back when the flight lands (enterSketchView's onArrive).
  }

  /** Apply an edited dimension value (mm) to an entity. Line length and circle
   *  diameter become driving solver constraints (so other constraints are kept);
   *  everything else (rectangle W/H, line angle) edits coordinates directly. */
  private editDimension(index: number, field: DimField, mm: number) {
    const e = this.entities[index];
    if (!e) return;
    if (e.type === "line" && field === "length") {
      this.setDrivingDimension({ type: "distance", line: e.id, value: mm });
      return;
    }
    if (e.type === "circle" && field === "diameter") {
      this.setDrivingDimension({ type: "diameter", circle: e.id, value: mm });
      return;
    }
    entityDims(e).find((d) => d.field === field)?.write(mm);
    this.refreshActive();
  }

  /** When the solver WASM will not start, write length and diameter dims straight into
   *  the geometry; they otherwise did nothing. The constraint is kept for a real
   *  solver, and two-entity dims are left alone since only a solve says which moves. */
  private applyDrivingDimsDirectly() {
    if (!applyDrivingDimsDirect(this.entities, this.constraints)) return;
    this.entityVersion++; // guards any in-flight solve against this write
    if (!this.directDimToast) {
      this.directDimToast = true;
      toast(
        "The solver is not running, so this value is applied to the shape rather than kept as a live dimension",
        { timeout: 12000 },
      );
    }
    this.refreshActive();
    this.onState?.();
  }

  /** clickable labels for the distance constraints: editing one writes the
   *  constraint's driving value and re-solves. Reads the cdims activeCurves()
   *  computed earlier in the same refreshActive() pass. */

  // --- dimension label placement (drag) ---------------------------------
  // Placement lives on the constraint, or on the entity (`dimPlace`) for badges.
  // It never changes geometry, so neither path re-solves.

  /** Mid-drag stays cheap: refreshActive() would tear down the label being dragged. */
  private afterPlaceDrag(done: boolean, anchor: () => THREE.Vector2 | null): THREE.Vector2 | null {
    if (done) {
      this.refreshActive();
      this.onState?.(); // undo checkpoint: the placement is a document edit
      return null; // labels were just rebuilt, the caller's is gone
    }
    this.overlay.setActiveSketch(this.activeCurves(this.derivedEntities())); // also refreshes this.cdims
    this.viewport.requestRender();
    return anchor();
  }

  /** Persist a dragged badge placement; dragging back onto the geometry clears it. */
  private commitEntityPlace(
    index: number, field: DimField, ox: number, oy: number, done: boolean,
  ): THREE.Vector2 | null {
    const e = this.entities[index];
    if (!e || !isBadgeEntity(e)) return null; // not a badge-bearing type
    const p = clampPlace(ox, oy, this.planeMmPerPx());
    const next = { ...dimPlaceOf(e) };
    if (p) next[field] = p;
    else delete next[field];
    if (Object.keys(next).length) e.dimPlace = next;
    else delete e.dimPlace; // omit when empty (byte stability, like every optional)
    return this.afterPlaceDrag(done, () => {
      const cur = this.entities[index];
      if (!cur) return null;
      // recompute through the same neighbour-aware defaults the labels render
      // with, so a mid-drag label tracks its dim's REAL anchor
      const def = staggeredDefaults(this.entities).get(cur.id);
      return entityDims(cur, def).find((d) => d.field === field)?.labelPos ?? null;
    });
  }

  /** Persist a dragged CONSTRAINT dim placement (the placed dims, see
   *  isPlacedDim, which is exactly the set that carries `place`). */
  private commitConstraintPlace(cIndex: number, ox: number, oy: number, done: boolean): THREE.Vector2 | null {
    const c = this.constraints[cIndex];
    if (!c || !isPlacedDim(c)) return null;
    const p = clampPlace(ox, oy, this.planeMmPerPx());
    const { place: _dropped, ...rest } = c;
    this.constraints[cIndex] = (p ? { ...c, place: p } : rest) as SketchConstraint;
    return this.afterPlaceDrag(done, () => this.cdims.find((d) => d.cIndex === cIndex)?.labelPos ?? null);
  }

  private constraintDimExtras(): ExtraDim[] {
    return this.cdims.map((d) => {
      const st = diagnosisOf(d.cIndex, this.conflictIdx, this.overIdx);
      const con = this.constraints[d.cIndex];
      const key = con && isDimConstraint(con) && con.id ? `c:${con.id}` : null;
      const expr = key ? this.exprFor(key) : undefined;
      return {
        anchor: d.labelPos,
        valueMm: d.valueMm,
        ...(d.kind ? { kind: d.kind } : {}),
        ...(d.driven ? { driven: true } : {}),
        ...(st === "conflict" ? { conflict: true } : st === "over" ? { over: true } : {}),
        ...(expr ? { expr } : {}),
        // draggable only when this dim's constraint has a `place` slot to write
        // to (constraintDims omits `place` for the ones that don't)
        ...(d.place
          ? {
            place: d.place,
            placeCommit: (ox: number, oy: number, done: boolean) =>
              this.commitConstraintPlace(d.cIndex, ox, oy, done),
          }
          : {}),
        commit: (val: number) => {
          const c = this.constraints[d.cIndex];
          if (c && isPlacedDim(c)) this.writeDimValue(c, val);
        },
        onDelete: () => this.deleteConstraint(d.cIndex),
        commitExpr: (raw: string) => {
          const c = this.constraints[d.cIndex];
          if (!c || !isDimConstraint(c)) return "not editable";
          if (!c.id) c.id = newConstraintId();
          return this.commitExprInput(`c:${c.id}`, d.kind === "angle" ? "angle" : "length", raw, (v) => {
            this.writeDimValue(c, v);
          });
        },
      };
    });
  }

  /** The one write for both edit paths: an offset dim shows |value| but stores the
   *  sign of its side, so typing "3" into an inward offset must stay inward. */
  private writeDimValue(c: SketchConstraint & { value: number }, val: number) {
    c.value = c.type === "offset" && c.value < 0 ? -Math.abs(val) : val;
    this.requestSolve();
    this.onState?.();
  }

  /** Add/replace the driving dimension on an entity, then re-solve. A dim gets
   *  its stable id at birth; a replacement inherits the replaced dim's id, so a
   *  parameter binding survives retyping the dimension. */
  private setDrivingDimension(c: SketchConstraint) {
    // radialGap and c2cDistance are one intent in two formulations, so one target.
    const rimPair = (k: SketchConstraint): string | null =>
      k.type === "radialGap" ? [k.inner, k.outer].sort().join("|")
        : k.type === "c2cDistance" ? [k.c1, k.c2].sort().join("|")
          : null;
    const sameTarget = (k: SketchConstraint): boolean => {
      if (c.type === "distance" && k.type === "distance") return k.line === c.line;
      if (c.type === "diameter" && k.type === "diameter") return k.circle === c.circle;
      if (c.type === "p2pDistance" && k.type === "p2pDistance") {
        return (
          (k.e1 === c.e1 && k.p1 === c.p1 && k.e2 === c.e2 && k.p2 === c.p2) ||
          (k.e1 === c.e2 && k.p1 === c.p2 && k.e2 === c.e1 && k.p2 === c.p1)
        );
      }
      if (c.type === "p2lDistance" && k.type === "p2lDistance") {
        return k.e === c.e && k.p === c.p && k.line === c.line;
      }
      if (c.type === "radius" && k.type === "radius") return k.e === c.e;
      if (c.type === "angle" && k.type === "angle") {
        return (k.l1 === c.l1 && k.l2 === c.l2) || (k.l1 === c.l2 && k.l2 === c.l1);
      }
      const pair = rimPair(c);
      if (pair !== null) return pair === rimPair(k);
      // One dim per offset operation, keyed by its copies; the id is inherited for bindings.
      if (c.type === "offset" && k.type === "offset") {
        const key = (o: typeof c) => o.pairs.map((p) => p.cpy).sort().join("|");
        return key(c) === key(k);
      }
      if (c.type === "c2lDistance" && k.type === "c2lDistance") return k.circle === c.circle && k.line === c.line;
      if (c.type === "p2cDistance" && k.type === "p2cDistance") {
        return k.e === c.e && k.p === c.p && k.circle === c.circle;
      }
      return false;
    };
    let replacedId: string | undefined;
    this.constraints = this.constraints.filter((k) => {
      if (!sameTarget(k)) return true;
      if (isDimConstraint(k) && k.id) replacedId = k.id;
      return false;
    });
    if (isDimConstraint(c) && !c.id) c.id = replacedId ?? newConstraintId();
    this.constraints.push(c);
    this.requestSolve();
    if (this.solverDead) this.applyDrivingDimsDirectly();
  }

  // --- parameter bindings on sketch dims -------------------------------------
  // Held here while the sketch is open (keys `c:<constraintId>` and
  // `e:<entityId>:<field>`) and applied in the same mutate as the commit.
  private pendingBindings = new Map<string, { expr: string; kind: FieldKind; name?: string }>();

  /** the sketch feature id currently open for editing (null for a new sketch
   *  or when the editor is closed), the store's cascade must not headlessly
   *  overwrite it. */
  get openDocId(): string | null {
    return this.active ? this.editingId : null;
  }

  /** binding key → ParamTarget once the owning sketch id is known. */
  private static targetOf(key: string, sketchId: string): ParamTarget {
    const [t, id, field] = key.split(":");
    return t === "c"
      ? { kind: "constraint", sketch: sketchId, constraint: id! }
      : { kind: "entity", sketch: sketchId, entity: id!, field: field! };
  }

  /** SketchBinding list for the commit; targets get the final sketch id. */
  private drainBindings(sketchId: string): SketchBinding[] {
    const out: SketchBinding[] = [];
    for (const [key, b] of this.pendingBindings) {
      out.push({ target: SketchMode.targetOf(key, sketchId), expr: b.expr, kind: b.kind, ...(b.name ? { name: b.name } : {}) });
    }
    this.pendingBindings.clear();
    return out;
  }

  /** the DOCUMENT-side binding for a pending key (editing an existing sketch). */
  private docBinding(key: string): { name: string; expr: string; value: number } | null {
    if (!this.editingId || !this.store) return null;
    return this.store.boundExpr(SketchMode.targetOf(key, this.editingId));
  }

  /** the driving expression for a bound dim key, pending is preferred over the doc. */
  private exprFor(key: string): string | undefined {
    return this.pendingBindings.get(key)?.expr ?? this.docBinding(key)?.expr;
  }

  /** A plain number in display units, or an expression (optionally `name=expr`) in
   *  canonical units. `expr` is null for a number; `name` only when renaming. */
  private evalDimInput(raw: string, kind: FieldKind, key: string | null): { value: number; expr: string | null; name?: string } | { error: string } {
    if (isPlainNumber(raw)) {
      const value = parseField(raw, kind);
      if (value == null || (kind !== "angle" && !(value > 0))) return { error: "invalid value" };
      return { value, expr: null };
    }
    if (!this.store) return { error: "no document" };
    const bound = key ? (this.docBinding(key)?.name ?? null) : null;
    const pending = key ? (this.pendingBindings.get(key)?.name ?? null) : null;
    const c = this.store.classifyTargetExpr(bound, pending, raw, kind);
    if (!c.ok) return { error: c.error };
    if (kind !== "angle" && !(c.value > 0)) return { error: "must evaluate to a positive value" };
    return { value: c.value, expr: c.expr, ...(c.name ? { name: c.name } : {}) };
  }

  /** Record/refresh the pending binding for a dim edit: formulas always bind
   *  (a `name=expr` name overrides, else a previously chosen name survives);
   *  a plain number keeps an EXISTING binding as its literal. */
  private recordBinding(key: string, r: { value: number; expr: string | null; name?: string }, kind: FieldKind) {
    if (r.name) {
      this.pendingBindings.set(key, { expr: r.expr!, kind, name: r.name });
      return;
    }
    const prior = this.pendingBindings.get(key);
    const keepName = prior?.name ? { name: prior.name } : {};
    if (r.expr) this.pendingBindings.set(key, { expr: r.expr, kind, ...keepName });
    else if (prior || this.docBinding(key)) this.pendingBindings.set(key, { expr: String(r.value), kind, ...keepName });
  }

  /** Shared raw-input commit for a bindable dim slot with a known key. */
  private commitExprInput(key: string, kind: FieldKind, raw: string, apply: (value: number) => void): string | null {
    const r = this.evalDimInput(raw, kind, key);
    if ("error" in r) return r.error;
    this.recordBinding(key, r, kind);
    apply(r.value);
    return null;
  }

  /** Line length and circle diameter bind through their driving constraint; rigid
   *  fields bind as entity targets. Rectangle W/H and derived dims take numbers only. */
  private commitEntityDimExpr(index: number, field: DimField, raw: string): string | null {
    const e = this.entities[index];
    if (!e) return "no entity";
    if (e.type === "line" && field === "length") return this.commitConvertedDim({ type: "distance", line: e.id, value: 0 }, raw);
    if (e.type === "circle" && field === "diameter") return this.commitConvertedDim({ type: "diameter", circle: e.id, value: 0 }, raw);
    const bindable = RIGID_ENTITY_NUM_FIELDS[e.type]?.some(([f]) => f === field);
    if (!bindable) return "this dimension can't hold an expression yet";
    return this.commitExprInput(`e:${e.id}:${field}`, "length", raw, (v) => {
      entityDims(e).find((d) => d.field === field)?.write(coerceForField(field, v));
      this.refreshActive();
      this.onState?.();
    });
  }

  /** Entity length/⌀ input that must live on a driving constraint: evaluate
   *  first, place the constraint (id carries over on replace), then bind. */
  private commitConvertedDim(base: Extract<SketchConstraint, { type: "distance" } | { type: "diameter" }>, raw: string): string | null {
    const prior =
      base.type === "distance"
        ? this.constraints.find((k): k is Extract<SketchConstraint, { type: "distance" }> => k.type === "distance" && k.line === base.line)
        : this.constraints.find((k): k is Extract<SketchConstraint, { type: "diameter" }> => k.type === "diameter" && k.circle === base.circle);
    const r = this.evalDimInput(raw, "length", prior?.id ? `c:${prior.id}` : null);
    if ("error" in r) return r.error;
    const c = { ...base, value: r.value };
    this.setDrivingDimension(c); // stamps a fresh id or inherits the replaced dim's
    this.recordBinding(`c:${(c as { id?: string }).id!}`, r, "length");
    this.onState?.();
    return null;
  }

  /** the driving expression shown on an entity dim label, when bound. */
  private entityDimExpr(index: number, field: DimField): string | undefined {
    const e = this.entities[index];
    if (!e) return undefined;
    if (e.type === "line" && field === "length") {
      const c = this.constraints.find((k): k is Extract<SketchConstraint, { type: "distance" }> => k.type === "distance" && k.line === e.id);
      return c?.id ? this.exprFor(`c:${c.id}`) : undefined;
    }
    if (e.type === "circle" && field === "diameter") {
      const c = this.constraints.find((k): k is Extract<SketchConstraint, { type: "diameter" }> => k.type === "diameter" && k.circle === e.id);
      return c?.id ? this.exprFor(`c:${c.id}`) : undefined;
    }
    if (RIGID_ENTITY_NUM_FIELDS[e.type]?.some(([f]) => f === field)) return this.exprFor(`e:${e.id}:${field}`);
    return undefined;
  }

  /** A parameter commit landed (store.onParamsApplied): refresh every bound
   *  live dim value, document bindings read the table, pending ones
   *  re-evaluate, then re-solve so the geometry follows. */
  syncParamValues() {
    if (!this.active || !this.store) return;
    const valueFor = (key: string): number | null => {
      const pend = this.pendingBindings.get(key);
      if (pend) {
        const v = this.store!.classifyTargetExpr(null, null, pend.expr, pend.kind);
        return v.ok ? v.value : null;
      }
      return this.docBinding(key)?.value ?? null;
    };
    let touched = false;
    for (const c of this.constraints) {
      if (!isDimConstraint(c) || !c.id) continue;
      const next = valueFor(`c:${c.id}`);
      if (next != null && next !== c.value) {
        c.value = next;
        touched = true;
      }
    }
    for (const e of this.entities) {
      for (const [field] of RIGID_ENTITY_NUM_FIELDS[e.type] ?? []) {
        const next = valueFor(`e:${e.id}:${field}`);
        if (next == null) continue;
        const rec = e as unknown as Record<string, unknown>;
        const coerced = coerceForField(field, next);
        if (rec[field] !== coerced) {
          rec[field] = coerced;
          touched = true;
        }
      }
    }
    if (touched) {
      this.armPreEdit(); // parameter sync is DERIVED, never an undo step
      this.requestSolve();
      this.refreshActive();
      this.onState?.();
    }
  }

  /** Patch the open session's projected entities and re-solve; finish() persists them. */
  syncProjectedCurves(updates: ProjectionUpdate[]) {
    if (!this.active) return;
    let touched = false;
    for (const u of updates) {
      const i = this.entities.findIndex((x) => x.type === "projected" && x.id === u.entity);
      const e = this.entities[i];
      if (!e || e.type !== "projected") continue;
      if (u.stale && e.stale) continue; // already flagged, nothing changes
      this.entities[i] = applyProjectionUpdate(e, u);
      touched = true;
    }
    if (touched) {
      this.armPreEdit(); // projection refresh is DERIVED, never an undo step
      this.requestSolve();
      this.refreshActive();
    }
  }

  /** A badge over geometry lets the geometry take the click (the canvas never sees
   *  it). True when something underneath was selected. */
  private labelOverlapSelect(e: PointerEvent): boolean {
    if (this.tool === "dimension") return this.labelOverlapDimension(e);
    if (this.tool !== "select") return false;
    const raw = this.planePoint(e);
    if (!raw) return false;
    const idx = pickEntity(this.entities, raw, this.pickTol());
    const ent = idx >= 0 ? this.entities[idx] : undefined;
    if (!ent) return false;
    if (e.shiftKey) {
      if (!this.selected.delete(ent.id)) this.selected.add(ent.id);
    } else {
      this.selected = new Set([ent.id]);
    }
    this.refreshActive();
    return true;
  }

  /** In the dimension tool, a label click belongs to dimensioning unless no picks are
   *  taken and nothing is underneath. */
  private labelOverlapDimension(e: PointerEvent): boolean {
    const raw = this.planePoint(e);
    if (!raw) return false;
    const midDimension = this.dimFlow.picking;
    if (!midDimension && !pickDimTarget(this.entities, raw, this.pickTol())) {
      return false; // the annotation owns this click
    }
    this.dimFlow.dimensionClick(raw, e);
    return true;
  }

  private onPointerDown(e: PointerEvent) {
    // A label stops propagation on its own pointerdown, so reaching here means
    // the click landed away from every dimension: drop the label selection so a
    // later Delete can't remove a dimension the user is no longer pointing at.
    this.dims.clearSelection();
    if (e.button === 2) { this.rightDownAt = { x: e.clientX, y: e.clientY }; this.rightDragged = false; }
    if (e.button !== 0) return; // left only; middle/right still navigate
    // Project picks 3D model geometry / committed sketch curves, it needs the
    // raw client coords, so it branches BEFORE the plane-point conversion.
    if (this.tool === "project") {
      e.preventDefault();
      void this.projectFlow.projectClick(e);
      return;
    }
    // After Project, which picks in 3D and does not care which way the plane faces.
    if (this.planeTooEdgeOn()) {
      e.preventDefault();
      setPrompt("The sketch plane is edge-on, turn the view to draw on it");
      return;
    }
    // The raw point: a snap would pull it off a circle's rim.
    if (this.tool === "dimension") {
      const raw = this.planePoint(e);
      if (!raw) return;
      e.preventDefault();
      this.dimFlow.dimensionClick(raw, e);
      return;
    }
    const hit = this.snapAt(e.clientX, e.clientY, e.ctrlKey);
    if (!hit) return;
    e.preventDefault();
    const p = hit.p;

    // SK-6: a click that visibly snapped to the Origin marker while DRAWING
    // (never select/modify/pattern, which have their own notions of what a
    // click here means) is a claim the user is making about where this corner
    // belongs, not a coincidence the solver should feel free to undo the next
    // time something unrelated gets dimensioned. Pin it now, the same real,
    // fixed point the dimension tool would create picking the Origin by hand
    // (snap.ts pinOriginPoint): any entity whose corner lands exactly here
    // (this click, or the next) shares that point and inherits the fix.
    if (
      hit.kind === "center" && hit.label === "Origin" &&
      this.tool !== "select" && !MODIFY_TOOLS.has(this.tool) && !PATTERN_TOOLS.has(this.tool)
    ) {
      pinOriginPoint(this.entities, this.constraints, p, newEntityId);
    }

    if (this.tool === "select") {
      // Note: Chromium reports detail 0 on pointerdown, so a double press is timed here
      const now = performance.now();
      const last = this.lastPress;
      const secondPress = e.detail >= 2 || (now - last.t < 450 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 6);
      this.lastPress = secondPress ? { t: 0, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
      this.selectedPole = null; // a release on a pole picks it again
      // grab a point to drag it, connected/constrained geometry follows
      const gp = this.pickPoint(p);
      if (gp) {
        this.dragFrom = gp.p.clone();
        this.dragEntIdx = gp.idx;
        this.dragPole = gp.pole;
        this.dragStartClient = { x: e.clientX, y: e.clientY };
        this.dragMoved = false;
        this.dragShift = e.shiftKey;
        this.dragRefusedToast = false;
        this.dragSnapshot = JSON.parse(JSON.stringify(this.entities)); // for Esc-cancel revert
        this.dragAnchors = this.anchorsAwayFrom(gp.idx, gp.p);
        try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
        return;
      }
      // no draggable vertex under the cursor → (de)select the entity body / area
      const raw = this.planePoint(e) ?? p;
      // Double-click a derived copy edits its pattern; a single click selects the cell's area.
      const derived = this.derivedEntities();
      const di = pickEntity(derived, raw, this.pickTol());
      const de = di >= 0 ? derived[di] : undefined;
      if (de && e.detail >= 2) {
        this.editPattern(de.id.split("#")[0] ?? de.id);
        return;
      }
      // DOUBLE-click text → re-open the text panel to edit it in place. (Text isn't
      // pickable as an entity, entitySegments is empty, so it's found via its glyph
      // group's bounding box, a generous hit that lands even between letters.)
      if (e.detail >= 2) {
        const te = this.textEntityAt(raw);
        if (te) {
          this.editText(te, e);
          return;
        }
      }
      if (secondPress && this.insertPoleAt(raw)) return;
      // a press on a shown control polygon keeps it shown, the first half of
      // the double-click that inserts a pole
      if (this.polygonLegAt(raw)) return;
      // a real (hand-drawn) entity's body under the cursor → arm a body drag;
      // a plain click (no movement) falls through to selection in endDrag()
      const idx = pickEntity(this.entities, raw, this.pickTol());
      const hit = idx >= 0 ? this.entities[idx] : undefined;
      if (hit) {
        this.moveDrag = {
          idx,
          startClient: { x: e.clientX, y: e.clientY },
          last: raw.clone(),
          started: false,
          shift: e.shiftKey,
          stretch: [],
        };
        try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
        return;
      }
      // A text has no segments for pickEntity, so it is grabbed anywhere in its block.
      const text = this.textEntityAt(raw);
      if (text) {
        this.moveDrag = {
          idx: this.entities.indexOf(text),
          startClient: { x: e.clientX, y: e.clientY },
          last: raw.clone(),
          started: false,
          shift: e.shiftKey || e.ctrlKey || e.metaKey,
          stretch: [],
          region: this.overlay.activeRegionAt(raw),
        };
        try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
        return;
      }
      // Otherwise a profile AREA (patterned cells and sub-areas carved by a
      // crossing curve included) or empty space. Either can start a selection
      // box, so what the click means is settled on release.
      this.boxDown = {
        x: e.clientX,
        y: e.clientY,
        additive: e.shiftKey || e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
        base: e.shiftKey || e.ctrlKey || e.metaKey ? new Set(this.selected) : new Set(),
        region: this.overlay.activeRegionAt(raw),
      };
      try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
      return;
    }
    if (PATTERN_TOOLS.has(this.tool)) {
      if (this.patternFlow.grabCentre(e.clientX, e.clientY)) {
        try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
        return;
      }
      if (this.pickPatternSources(this.planePoint(e) ?? p)) return;
      return this.patternClick(p);
    }
    if (this.tool === "arc") return this.arcClick(p);
    if (this.tool === "spline") return this.splineClick(p);
    if (this.tool === "bspline") return this.bsplineClick(p);
    if (this.tool === "point") return this.pointClick(p);
    if (this.tool === "text") {
      // click on existing text → edit it (discoverable: the text tool also edits);
      // otherwise begin a placement: drag to define a box, or release for a point anchor
      const te = this.textEntityAt(p);
      if (te) { this.editText(te, e); return; }
      this.textBoxStart = p.clone();
      this.textBoxEnd = null;
      this.textBoxScreen = { x: e.clientX, y: e.clientY };
      try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      return;
    }
    if (this.tool === "polygon") return this.polygonClick(p);
    if (this.tool === "slot") return this.slotClick(p);
    if (this.tool === "circle2") return this.circle2Click(p);
    if (this.tool === "circle3") return this.circle3Click(p);
    if (this.tool === "centerRectangle") return this.centerRectClick(p);
    if (this.tool === "rectangle3") return this.rect3Click(p);
    if (this.tool === "mirror") return this.mirrorClick(p);
    if (this.tool === "trim") return this.modifyFlow.trimClick(p);
    if (this.tool === "fillet") return this.modifyFlow.filletClick(p);
    if (this.tool === "chamfer") return this.modifyFlow.chamferClick(p);
    if (this.tool === "move" || this.tool === "copy") return this.modifyFlow.moveClick(p);
    if (this.tool === "rotate") return this.modifyFlow.rotateClick(p);
    if (this.tool === "scale") return this.modifyFlow.scaleClick(p);
    if (this.tool === "offset") return this.modifyFlow.offsetClick(p);
    if (this.tool === "extend") return this.modifyFlow.extendClick(p);
    if (this.tool === "break") return this.modifyFlow.breakClick(p);
    if (CONSTRAINT_TOOLS.has(this.tool)) return this.constraintClick(p);

    if (!this.base) {
      this.base = p.clone();
      if (this.tool === "line") this.chainStart = p.clone(); // remember loop start
      this.showDimFields();
      return;
    }
    // second click → commit the entity using current dims
    this.commitFromCursor(p);
  }

  // 3-point arc: click start, click end, then click the point it passes through
  private arcClick(p: THREE.Vector2) {
    if (!this.arcStart) {
      this.arcStart = p.clone();
    } else if (!this.arcEnd) {
      this.arcEnd = p.clone();
    } else {
      const a = this.arcStart;
      const b = this.arcEnd;
      const ent: ResolvedEntity = {
        type: "arc",
        id: newEntityId(),
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        mx: p.x,
        my: p.y,
      };
      if (this.constructionMode) ent.construction = true;
      this.entities.push(ent);
      this.arcStart = null;
      this.arcEnd = null;
      this.refreshActive();
      this.overlay.setPreview([]);
      this.requestSolve(); // include the arc in the solve (updates DOF colour)
      this.onState?.();
    }
  }

  // MCAD-style fit-point spline: click to drop points; click the last point
  // again (or press Enter) to finish, Escape to cancel.
  private splineClick(p: THREE.Vector2) {
    const last = this.splinePts[this.splinePts.length - 1];
    if (last && last.distanceTo(p) < 1e-3) {
      this.finishSpline();
      return;
    }
    this.splinePts.push(p.clone());
  }

  private finishSpline() {
    if (this.splinePts.length >= 2) {
      const ent: ResolvedEntity = {
        type: "spline",
        id: newEntityId(),
        points: this.splinePts.map((q) => ({ x: q.x, y: q.y })),
      };
      if (this.constructionMode) ent.construction = true;
      this.entities.push(ent);
      this.refreshActive();
      this.requestSolve();
    }
    this.splinePts = [];
    this.overlay.setPreview([]);
    this.onState?.();
  }

  private splinePreview(cursor: THREE.Vector2) {
    if (!this.splinePts.length) return this.overlay.setPreview([]);
    const pts = [...this.splinePts.map((q) => ({ x: q.x, y: q.y })), { x: cursor.x, y: cursor.y }];
    this.overlay.setPreview([this.entityCurve({ type: "spline", id: "", points: pts })]);
  }

  // Control point spline: click poles; clicking the first again closes the
  // curve, clicking the last again (or Enter) finishes it open.
  private bsplineClick(p: THREE.Vector2) {
    const pts = this.splinePts;
    const tol = this.pickTol();
    const first = pts[0], last = pts[pts.length - 1];
    if (first && pts.length >= 3 && first.distanceTo(p) <= tol) return this.finishBspline(true);
    if (last && last.distanceTo(p) <= tol) return this.finishBspline(false);
    pts.push(p.clone());
  }

  private finishBspline(closed: boolean) {
    if (this.splinePts.length >= (closed ? 3 : 2)) {
      const ent: ResolvedEntity = {
        type: "bspline",
        id: newEntityId(),
        poles: this.splinePts.map((q) => ({ x: q.x, y: q.y })),
        ...(closed ? { closed: true } : {}),
      };
      if (this.constructionMode) ent.construction = true;
      this.entities.push(ent);
      this.selected = new Set([ent.id]);
      this.refreshActive();
      this.requestSolve();
    }
    this.splinePts = [];
    this.overlay.setPreview([]);
    this.onState?.();
  }

  private bsplinePreview(cursor: THREE.Vector2) {
    const pts = this.splinePts;
    if (!pts.length) return this.overlay.setPreview([]);
    const closing = pts.length >= 3 && pts[0]!.distanceTo(cursor) <= this.pickTol();
    const draft: BsplineEntity = {
      type: "bspline", id: "",
      poles: [...pts, ...(closing ? [] : [cursor])].map((q) => ({ x: q.x, y: q.y })),
      ...(closing ? { closed: true } : {}),
    };
    this.overlay.setPreview([this.entityCurve(draft), controlPolygonObjects(draft, this.plane, this.planeMmPerPx())]);
  }

  /** The control polygons of the selected control-point splines, and on the
   *  others the poles a constraint or dimension holds. */
  private polygonObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const e of this.entities) {
      if (e.type !== "bspline") continue;
      if (!this.selected.has(e.id)) {
        const held = constrainedPoles(this.constraints, e.id, e.poles.length);
        if (held.length) out.push(poleMarkerObjects(e, this.plane, this.planeMmPerPx(), held));
        continue;
      }
      const active = this.selectedPole?.id === e.id ? this.selectedPole.k : -1;
      out.push(controlPolygonObjects(e, this.plane, this.planeMmPerPx(), active));
    }
    return out;
  }

  private polygonLegAt(p: THREE.Vector2): boolean {
    const tol = this.pickTol();
    return this.entities.some((e) => e.type === "bspline" && this.selected.has(e.id) && polygonParam(e, p, tol) !== null);
  }

  /** Double-click on a selected control-point spline's polygon, or on any one's
   *  curve, adds a pole there without moving the curve. */
  private insertPoleAt(p: THREE.Vector2): boolean {
    const tol = this.pickTol();
    const order = [...this.entities].sort((a, b) => Number(this.selected.has(b.id)) - Number(this.selected.has(a.id)));
    for (const e of order) {
      if (e.type !== "bspline") continue;
      const r = insertPole(e, p, tol, this.constraints, this.selected.has(e.id));
      if (!r) continue;
      this.entities = this.entities.map((x) => (x.id === e.id ? r.entity : x));
      this.constraints = r.constraints;
      this.selected = new Set([e.id]);
      this.selectedPole = { id: e.id, k: r.pole };
      this.afterModify();
      return true;
    }
    return false;
  }

  /** Delete the selected pole, down to the fewest its degree allows. */
  private deleteSelectedPole(): boolean {
    const sp = this.selectedPole;
    const e = sp ? this.entities.find((x) => x.id === sp.id) : undefined;
    if (!sp || e?.type !== "bspline" || !this.selected.has(e.id)) return false;
    const r = deletePole(e, sp.k, this.constraints);
    this.selectedPole = null;
    if (!r) {
      toast(`A degree ${bsplineDegree(e)} spline keeps at least ${bsplineMinPoles(e)} control points`);
      return true;
    }
    this.entities = this.entities.map((x) => (x.id === e.id ? r.entity : x));
    this.constraints = r.constraints;
    this.afterModify();
    return true;
  }

  /** Change the selected control-point splines' degree or closure; the knots go
   *  back to uniform, as their count depends on both. */
  private reshapeSelectedBsplines(change: { degree?: number; closed?: boolean }) {
    this.entities = this.entities.map((e) => {
      if (e.type !== "bspline" || !this.selected.has(e.id)) return e;
      const { knots: _uniform, closed: _c, ...rest } = e;
      const closed = change.closed ?? e.closed;
      return { ...rest, ...(change.degree ? { degree: change.degree } : {}), ...(closed ? { closed: true } : {}) };
    });
    this.afterModify();
  }

  /** "Edit as Control Points": the selected fit-point splines become control-point ones. */
  private convertSelectedSplines() {
    for (const e of [...this.entities]) {
      if (e.type !== "spline" || !this.selected.has(e.id)) continue;
      const r = splineToBspline(e, this.constraints);
      if (!r) continue;
      this.entities = this.entities.map((x) => (x.id === e.id ? r.entity : x));
      this.constraints = r.constraints;
    }
    this.afterModify();
  }

  /** rubber-band preview for the multi-click primitive tools */
  private multiClickPreview(cursor: THREE.Vector2, e?: PointerEvent) {
    const pv: ResolvedEntity[] = [];
    let dims: Record<string, number> | null = null;
    if (this.tool === "polygon" && this.clickPts.length === 1) {
      const a = this.clickPts[0];
      if (a) {
        const vertex = this.polygonVertex(a, cursor);
        pv.push({ type: "polygon", id: "", x: a.x, y: a.y, radius: a.distanceTo(vertex), sides: Math.max(3, Math.round(this.polygonSides)), angle: (Math.atan2(vertex.y - a.y, vertex.x - a.x) * 180) / Math.PI });
        dims = { radius: a.distanceTo(vertex) };
      }
    } else if (this.tool === "slot") {
      if (this.clickPts.length === 1) {
        const a = this.clickPts[0];
        if (a) {
          const b = this.slotEnd(a, cursor);
          pv.push({ type: "line", id: "", x1: a.x, y1: a.y, x2: b.x, y2: b.y });
          dims = { length: a.distanceTo(b) };
        }
      } else if (this.clickPts.length === 2) {
        const [a, b] = this.clickPts;
        if (a && b) {
          const half = this.slotHalf(a, b, cursor);
          pv.push({ type: "slot", id: "", x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: half * 2 });
          dims = { width: half * 2 };
        }
      }
    } else if (this.tool === "circle2" && this.clickPts.length === 1) {
      const a = this.clickPts[0];
      if (a) {
        const end = this.circle2End(a, cursor);
        const ctr = a.clone().add(end).multiplyScalar(0.5);
        pv.push({ type: "circle", id: "", radius: a.distanceTo(end) / 2, x: ctr.x, y: ctr.y });
        dims = { diameter: a.distanceTo(end) };
      }
    } else if (this.tool === "circle3") {
      // fully determined by the three picked points, no dimension to type
      if (this.clickPts.length === 1) {
        const a = this.clickPts[0];
        if (a) pv.push({ type: "line", id: "", x1: a.x, y1: a.y, x2: cursor.x, y2: cursor.y });
      } else if (this.clickPts.length === 2) {
        const [a, b] = this.clickPts;
        const cc = a && b ? circumcenter(a, b, cursor) : null;
        if (cc) pv.push({ type: "circle", id: "", radius: cc.distanceTo(cursor), x: cc.x, y: cc.y });
      }
    } else if (this.tool === "centerRectangle" && this.clickPts.length === 1) {
      const c = this.clickPts[0];
      if (c) {
        const { w, h } = this.centerRectSize(c, cursor);
        pv.push({ type: "rectangle", id: "", width: w, height: h, x: c.x, y: c.y });
        dims = { width: w, height: h };
      }
    } else if (this.tool === "rectangle3") {
      // First leg is a bare LINE, like circle3's: there is no rectangle yet, and
      // previewing one from two points would have to invent a thickness.
      if (this.clickPts.length === 1) {
        const a = this.clickPts[0];
        if (a) {
          pv.push({ type: "line", id: "", x1: a.x, y1: a.y, x2: cursor.x, y2: cursor.y });
          dims = { width: a.distanceTo(cursor) };
        }
      } else if (this.clickPts.length === 2) {
        const [a, b] = this.clickPts;
        const r = a && b ? this.rect3From(a, b, cursor) : null;
        if (r) {
          pv.push({ type: "rectangle", id: "", width: r.width, height: r.height, x: r.x, y: r.y, angle: r.angle });
          dims = { width: r.width, height: r.height };
        }
      }
    }
    if (dims) {
      this.dim.updateFromCursor(dims);
      if (e) this.dim.position(e.clientX, e.clientY);
    }
    this.overlay.setPreview(pv.map((ent) => this.entityCurve(ent)));
  }

  // --- typed dims for the multi-click tools: the same isUserDriven gating the
  // single-drag tools use in computeGeometry(), shared by preview + commit ------

  /** dim fields per multi-click tool (and phase, for slot); Enter commits at the cursor */
  private showMultiDimFields() {
    const t = this.tool;
    const defs =
      t === "circle2"
        ? [{ name: "diameter", label: "Diameter", icon: "diameter" }]
        : t === "polygon"
          ? [{ name: "radius", label: "R" }, { name: "sides", label: "N", kind: "count" as const }]
          : t === "centerRectangle"
            ? [{ name: "width", label: "W" }, { name: "height", label: "H" }]
            : t === "rectangle3"
              // W is live from the first click (it is the edge being drawn); H
              // only means anything once that edge exists, and typing into it
              // early would be typing into a field with no geometry behind it.
              ? this.clickPts.length === 1
                ? [{ name: "width", label: "W" }]
                : [{ name: "width", label: "W" }, { name: "height", label: "H" }]
            : t === "slot"
              ? this.clickPts.length === 1
                ? [{ name: "length", label: "L" }]
                : [{ name: "width", label: "W" }]
              : null;
    if (!defs) return;
    this.dim.show(defs, () => this.multiClickAt(this.lastCursor.clone()));
  }

  private multiClickAt(p: THREE.Vector2) {
    if (this.tool === "polygon") this.polygonClick(p);
    else if (this.tool === "slot") this.slotClick(p);
    else if (this.tool === "circle2") this.circle2Click(p);
    else if (this.tool === "centerRectangle") this.centerRectClick(p);
    else if (this.tool === "rectangle3") this.rect3Click(p);
  }

  /** circle2: the second diameter endpoint, honoring a typed ⌀ (along a→cursor) */
  private circle2End(a: THREE.Vector2, cursor: THREE.Vector2): THREE.Vector2 {
    if (!this.dim.isUserDriven("diameter")) return cursor.clone();
    const dia = this.dim.getValue("diameter");
    if (dia == null || dia <= 0) return cursor.clone();
    const dir = cursor.clone().sub(a);
    if (dir.lengthSq() < 1e-8) dir.set(1, 0);
    else dir.normalize();
    return a.clone().add(dir.multiplyScalar(dia));
  }

  /** polygon: the first vertex, honoring a typed circumradius R (along center→cursor) */
  private polygonVertex(center: THREE.Vector2, cursor: THREE.Vector2): THREE.Vector2 {
    if (!this.dim.isUserDriven("radius")) return cursor.clone();
    const r = this.dim.getValue("radius");
    if (r == null || r <= 0) return cursor.clone();
    const dir = cursor.clone().sub(center);
    if (dir.lengthSq() < 1e-8) dir.set(1, 0);
    else dir.normalize();
    return center.clone().add(dir.multiplyScalar(r));
  }

  /** centerRectangle: full width/height, honoring typed values */
  private centerRectSize(c: THREE.Vector2, cursor: THREE.Vector2): { w: number; h: number } {
    let w = Math.abs(cursor.x - c.x) * 2;
    let h = Math.abs(cursor.y - c.y) * 2;
    if (this.dim.isUserDriven("width")) w = this.dim.getValue("width") ?? w;
    if (this.dim.isUserDriven("height")) h = this.dim.getValue("height") ?? h;
    return { w, h };
  }

  /** slot: the axis end point, honoring a typed length L (along a→cursor) */
  private slotEnd(a: THREE.Vector2, cursor: THREE.Vector2): THREE.Vector2 {
    if (!this.dim.isUserDriven("length")) return cursor.clone();
    const len = this.dim.getValue("length");
    if (len == null || len <= 0) return cursor.clone();
    const dir = cursor.clone().sub(a);
    if (dir.lengthSq() < 1e-8) dir.set(1, 0);
    else dir.normalize();
    return a.clone().add(dir.multiplyScalar(len));
  }

  /** slot: half-width from the cursor, honoring a typed full width W */
  private slotHalf(a: THREE.Vector2, b: THREE.Vector2, cursor: THREE.Vector2): number {
    if (this.dim.isUserDriven("width")) {
      const w = this.dim.getValue("width");
      if (w != null && w > 0) return w / 2;
    }
    return this.slotHalfWidth(a, b, cursor);
  }

  // --- point: a single click drops a reference/snap point ---------------
  private pointClick(p: THREE.Vector2) {
    const ent: ResolvedEntity = { type: "point", id: newEntityId(), x: p.x, y: p.y };
    this.overlay.setPreview([]);
    this.addDrawn(ent);
  }

  /** The plane angle of screen-right, so text follows the view's 90 degree rotation. */
  private viewRightAngle(): number {
    const right = new THREE.Vector3().setFromMatrixColumn(this.viewport.rig.active.matrixWorld, 0);
    return Math.atan2(right.dot(this.plane.v), right.dot(this.plane.u));
  }

  private rectContaining(
    p: THREE.Vector2,
    phi: number,
  ): { x: number; y: number; width: number } | null {
    let best: { x: number; y: number; width: number } | null = null;
    let bestArea = Infinity;
    for (const e of this.entities) {
      if (e.type !== "rectangle") continue;
      if (Math.abs(p.x - e.x) <= e.width / 2 && Math.abs(p.y - e.y) <= e.height / 2) {
        const area = e.width * e.height;
        if (area < bestArea) {
          bestArea = area;
          // wrap width = the rect's extent along the view's horizontal (screen-right)
          const w = e.width * Math.abs(Math.cos(phi)) + e.height * Math.abs(Math.sin(phi));
          best = { x: e.x, y: e.y, width: w };
        }
      }
    }
    return best;
  }

  /** True when a text preview was removed. */
  private dropTextPreview(): boolean {
    const before = this.entities.length;
    this.entities = this.entities.filter((e) => e.id !== TEXT_PREVIEW_ID);
    return this.entities.length !== before;
  }

  private textEntityAt(p: THREE.Vector2): Extract<ResolvedEntity, { type: "text" }> | null {
    const id = this.overlay.activeTextIdAt(p);
    if (!id) return null;
    const te = this.entities.find((x) => x.id === id);
    return te && te.type === "text" ? te : null;
  }

  /** Re-open the text panel to edit an existing text, anchored near the pointer. */
  private editText(te: Extract<ResolvedEntity, { type: "text" }>, e: PointerEvent) {
    this.openTextPanel(
      new THREE.Vector2(te.x, te.y),
      { x: e.clientX, y: e.clientY },
      undefined,
      te,
      this.viewRightAngle(),
    );
  }

  private openTextPanel(
    clickPoint: THREE.Vector2,
    screen: { x: number; y: number },
    explicitBox?: { x: number; y: number; width: number },
    editEntity?: Extract<ResolvedEntity, { type: "text" }>,
    viewPhi = 0,
  ) {
    // Text advances along the view's screen-right; `phiDeg` is baked into the stored
    // (plane-frame) angle so 0° in the panel = horizontal as the user sees it, and
    // editing subtracts it back out to show the user-facing angle.
    const phiDeg = (viewPhi * 180) / Math.PI;
    const box = editEntity
      ? editEntity.boxWidth !== undefined
        ? { x: editEntity.x, y: editEntity.y, width: editEntity.boxWidth }
        : undefined
      : (explicitBox ?? this.rectContaining(clickPoint, viewPhi));
    const anchor = editEntity
      ? { x: editEntity.x, y: editEntity.y }
      : box
        ? { x: box.x, y: box.y }
        : { x: clickPoint.x, y: clickPoint.y };
    const id = editEntity ? editEntity.id : newEntityId();
    const construction = editEntity ? !!editEntity.construction : this.constructionMode;
    const build = (v: TextValues): ResolvedEntity => ({
      type: "text", id, text: v.text,
      x: anchor.x, y: anchor.y, height: v.height, style: v.style,
      align: box ? "center" : v.align, angle: v.angle + phiDeg,
      ...(v.font ? { font: v.font } : {}),
      ...(v.boxWidth ? { boxWidth: v.boxWidth } : box ? { boxWidth: box.width } : {}),
      ...(editEntity?.pathRef !== undefined ? { pathRef: editEntity.pathRef } : {}),
      ...(editEntity?.positionOnPath !== undefined ? { positionOnPath: editEntity.positionOnPath } : {}),
      ...(construction ? { construction: true } : {}),
    });
    const initial: Partial<TextValues> = editEntity
      ? {
          text: editEntity.text, height: editEntity.height, angle: editEntity.angle - phiDeg,
          ...(editEntity.style ? { style: editEntity.style } : {}),
          ...(editEntity.align ? { align: editEntity.align } : {}),
          ...(editEntity.font ? { font: editEntity.font } : {}),
          ...(editEntity.boxWidth !== undefined ? { boxWidth: editEntity.boxWidth } : {}),
        }
      : { height: 10, ...(box ? { boxWidth: box.width, align: "center" } : {}) };
    // Editing: hide the original text so only the live preview shows; keep it to
    // restore if the edit is cancelled. editEntity is already the live list object.
    const original = editEntity;
    if (editEntity) {
      this.entities = this.entities.filter((e) => e.id !== id);
      this.selected.clear();
      this.overlay.clearRegionSelection();
      this.refreshActive();
    }
    this.textPanel.show(screen, this.fonts, initial, {
      onChange: (v) => {
        // live preview via a temporary entity on the active list, reuses the proven
        // committed-render path (setActiveSketch), which repaints when glyphs arrive.
        this.dropTextPreview();
        this.entities.push({ ...build(v), id: TEXT_PREVIEW_ID });
        this.refreshActive();
      },
      onCommit: (v) => {
        this.entities = this.entities.filter((e) => e.id !== TEXT_PREVIEW_ID && e.id !== id);
        this.entities.push(build(v));
        this.refreshActive();
        this.requestSolve();
        this.onState?.();
      },
      onCancel: () => {
        this.dropTextPreview();
        if (original) this.entities.push(original); // restore the unedited text
        this.refreshActive();
      },
    });
  }

  // --- patterns (patternFlow.ts) --------------------------------------------
  private patternClick(p: THREE.Vector2) {
    // entity patterns replicate the selection, drop projected reference
    // geometry from the sources BEFORE PatternFlow snapshots them
    if (ENTITY_PATTERNS.has(this.tool)) {
      for (const id of this.modifyFlow.warnSelectedProjected()) this.selected.delete(id);
    }
    this.patternFlow.click(p);
  }

  /** An entity pattern opened with nothing selected picks its sources in place:
   *  a click on a curve toggles it, a click inside a closed profile takes the
   *  curves around it. Anywhere else is the centre or start click. */
  private pickPatternSources(raw: THREE.Vector2): boolean {
    if (!ENTITY_PATTERNS.has(this.tool) || this.patternFlow.hasPending()) return false;
    let ids: string[] = [];
    const idx = pickEntity(this.entities, raw, this.pickTol());
    const hit = idx >= 0 ? this.entities[idx] : undefined;
    if (hit) ids = [hit.id];
    else if (!this.selected.size) {
      const wr = this.overlay.activeRegionAt(raw);
      if (wr) ids = this.entitiesAlongLoop(wr.region.loop);
    }
    if (!ids.length) return false;
    const all = ids.every((id) => this.selected.has(id));
    for (const id of ids) {
      if (all) this.selected.delete(id);
      else this.selected.add(id);
    }
    for (const id of this.modifyFlow.warnSelectedProjected()) this.selected.delete(id);
    const n = this.selected.size;
    setPrompt(n
      ? `${n} picked · click more to add · ${this.tool === "patternCircular" ? "click the centre" : "click where the pattern starts"}`
      : "Click the curves or profile to pattern");
    this.refreshActive();
    this.onState?.();
    return true;
  }

  private entitiesAlongLoop(loop: readonly THREE.Vector2[]): string[] {
    const ids = new Set<string>();
    const tol = this.pickTol();
    const step = Math.max(1, Math.floor(loop.length / 24));
    for (let i = 0; i < loop.length; i += step) {
      const pt = loop[i];
      if (!pt) continue;
      const k = pickEntity(this.entities, pt, tol);
      const ent = k >= 0 ? this.entities[k] : undefined;
      if (ent) ids.add(ent.id);
    }
    return [...ids];
  }

  private patternMove(p: THREE.Vector2, e: PointerEvent) {
    this.patternFlow.move(p, e);
  }

  private commitPattern() {
    this.patternFlow.commit();
  }

  /** Associative editing: re-open an existing pattern's placement flow with its
   *  current values, so dragging/typing re-derives it live. Esc restores it. */
  private editPattern(patId: string) {
    this.patternFlow.edit(patId);
  }


  private polygonClick(p: THREE.Vector2) {
    if (!this.clickPts.length) {
      this.clickPts = [p.clone()];
      this.showMultiDimFields(); // R
      return;
    }
    const center = this.clickPts[0];
    this.clickPts = [];
    this.overlay.setPreview([]);
    if (!center) return;
    // honor a typed side count (N); blank/invalid keeps the current count
    const rawN = this.dim.getValue("sides");
    if (rawN != null && Number.isFinite(rawN)) this.polygonSides = Math.max(3, Math.min(64, Math.round(rawN)));
    const vertex = this.polygonVertex(center, p);
    this.dim.hide();
    this.commitPolygon(center, vertex);
  }
  /** Commit a regular polygon as one parametric entity (rigid, the solver
   *  skips it; `angle` is the first-vertex angle in DEGREES). */
  private commitPolygon(center: THREE.Vector2, vertex: THREE.Vector2) {
    const r = center.distanceTo(vertex);
    if (r < 1e-4) return;
    const angle = (Math.atan2(vertex.y - center.y, vertex.x - center.x) * 180) / Math.PI;
    const e: ResolvedEntity = {
      type: "polygon", id: newEntityId(), x: center.x, y: center.y,
      radius: r, sides: Math.max(3, Math.round(this.polygonSides)), angle,
    };
    this.addDrawn(e);
  }

  /** Add a drawn entity, as construction geometry when that mode is on. */
  private addDrawn(ent: ResolvedEntity) {
    if (this.constructionMode) ent.construction = true;
    this.entities.push(ent);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  // --- slot: two center points, then a width point → rounded slot --------
  private slotClick(p: THREE.Vector2) {
    if (!this.clickPts.length) {
      this.clickPts = [p.clone()];
      this.showMultiDimFields(); // L
      return;
    }
    if (this.clickPts.length === 1) {
      const a = this.clickPts[0];
      this.clickPts.push(a ? this.slotEnd(a, p) : p.clone());
      this.showMultiDimFields(); // W (replaces the L field)
      return;
    }
    // third click sets the half-width (distance from the slot axis)
    const [a, b] = this.clickPts;
    this.clickPts = [];
    this.overlay.setPreview([]);
    if (!a || !b) return;
    const w = this.slotHalf(a, b, p);
    this.dim.hide();
    this.commitSlot(a, b, w);
  }
  private slotHalfWidth(a: THREE.Vector2, b: THREE.Vector2, cursor: THREE.Vector2): number {
    const dir = b.clone().sub(a);
    const len = dir.length() || 1;
    dir.divideScalar(len);
    const n = new THREE.Vector2(-dir.y, dir.x);
    return Math.max(0.5, Math.abs(cursor.clone().sub(a).dot(n)));
  }
  private commitSlot(a: THREE.Vector2, b: THREE.Vector2, w: number) {
    // w is the half-width (distance from the axis); the slot entity stores overall width
    if (a.distanceTo(b) < 1e-4 || w < 1e-4) return;
    const e: ResolvedEntity = { type: "slot", id: newEntityId(), x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: 2 * w };
    this.addDrawn(e);
  }

  // --- circle by 2 points (diameter endpoints) --------------------------
  private circle2Click(p: THREE.Vector2) {
    if (!this.clickPts.length) {
      this.clickPts = [p.clone()];
      this.showMultiDimFields(); // ⌀
      return;
    }
    const a = this.clickPts[0];
    this.clickPts = [];
    this.overlay.setPreview([]);
    if (!a) return;
    const end = this.circle2End(a, p);
    const center = a.clone().add(end).multiplyScalar(0.5);
    const r = a.distanceTo(end) / 2;
    const diameterTyped = this.dim.isUserDriven("diameter");
    this.dim.hide();
    this.commitCircle(center, r, diameterTyped);
  }

  // --- circle through 3 points ------------------------------------------
  private circle3Click(p: THREE.Vector2) {
    this.clickPts.push(p.clone());
    if (this.clickPts.length < 3) return;
    const [a, b, c] = this.clickPts;
    this.clickPts = [];
    this.overlay.setPreview([]);
    if (!a || !b || !c) return;
    const cc = circumcenter(a, b, c);
    if (!cc) return; // collinear
    this.commitCircle(cc, cc.distanceTo(a));
  }

  private commitCircle(center: THREE.Vector2, r: number, diameterTyped = false) {
    if (r < 1e-4) return;
    const ent: ResolvedEntity = { type: "circle", id: newEntityId(), radius: r, x: center.x, y: center.y };
    this.addDrawn(ent);
    this.lockTypedDims(ent, { diameter: diameterTyped });
  }

  // --- center rectangle: click center, then a corner --------------------
  private centerRectClick(p: THREE.Vector2) {
    if (!this.clickPts.length) {
      this.clickPts = [p.clone()];
      this.showMultiDimFields(); // W/H
      return;
    }
    const center = this.clickPts[0];
    this.clickPts = [];
    this.overlay.setPreview([]);
    if (!center) return;
    const { w, h } = this.centerRectSize(center, p);
    if (w < 1e-4 || h < 1e-4) return;
    const typed = { width: this.dim.isUserDriven("width"), height: this.dim.isUserDriven("height") };
    this.dim.hide();
    const ent: ResolvedEntity = { type: "rectangle", id: newEntityId(), width: w, height: h, x: center.x, y: center.y };
    this.addDrawn(ent);
    this.lockTypedDims(ent, typed);
  }

  // --- three-point rectangle: click one full EDGE, then its thickness -----

  /** A typed width stretches along the drawn angle; a typed height keeps the cursor's side. */
  private rect3From(a: THREE.Vector2, b: THREE.Vector2, cursor: THREE.Vector2) {
    let end = b;
    if (this.dim.isUserDriven("width")) {
      const w = this.dim.getValue("width");
      if (w != null && w > 0) {
        const dir = b.clone().sub(a);
        if (dir.lengthSq() < 1e-8) dir.set(1, 0);
        else dir.normalize();
        end = a.clone().add(dir.multiplyScalar(w));
      }
    }
    let third = cursor;
    if (this.dim.isUserDriven("height")) {
      const h = this.dim.getValue("height");
      if (h != null && h > 0) {
        // Move the third POINT rather than the finished rectangle's centre:
        // one code path, and the side the cursor is on is preserved for free.
        const u = end.clone().sub(a);
        if (u.lengthSq() < 1e-8) u.set(1, 0);
        else u.normalize();
        const n = new THREE.Vector2(-u.y, u.x);
        const side = Math.sign(cursor.clone().sub(a).dot(n)) || 1;
        third = a.clone().addScaledVector(n, side * h);
      }
    }
    return rectFromThreePoints(a, end, third);
  }

  private rect3Click(p: THREE.Vector2) {
    if (this.clickPts.length < 2) {
      this.clickPts.push(p.clone());
      this.showMultiDimFields(); // W after the first click, W+H after the second
      return;
    }
    const [a, b] = this.clickPts;
    this.clickPts = [];
    this.overlay.setPreview([]);
    if (!a || !b) return;
    const r = this.rect3From(a, b, p);
    if (!r) return; // no edge, or the third click landed on it
    const typed = { width: this.dim.isUserDriven("width"), height: this.dim.isUserDriven("height") };
    this.dim.hide();
    const ent: ResolvedEntity = {
      type: "rectangle", id: newEntityId(),
      width: r.width, height: r.height, x: r.x, y: r.y,
      // Omitted when it is 0, so an axis-aligned rectangle drawn with this tool
      // is byte-identical to one drawn with the others.
      ...(r.angle ? { angle: r.angle } : {}),
    };
    this.addDrawn(ent);
    this.lockTypedDims(ent, typed);
  }

  // --- mirror: click a line; reflect the multi-selection across it -------
  private mirrorClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    const axis = idx >= 0 ? this.entities[idx] : undefined;
    if (!axis || axis.type !== "line") return;
    const selectedSources = this.entities.filter((e) => this.selected.has(e.id) && e.id !== axis.id);
    // projected geometry is a fixed reference, mirror the rest of the selection
    // (it stays selected; the commit below clears the whole selection anyway)
    const projected = this.modifyFlow.warnSelectedProjected();
    const chosen = selectedSources.filter((e) => !projected.has(e.id));
    if (!chosen.length) return; // nothing selected to mirror
    const a = new THREE.Vector2(axis.x1, axis.y1);
    const b = new THREE.Vector2(axis.x2, axis.y2);
    for (const e of chosen) this.entities.push(this.reflectEntity(e, a, b));
    this.selected.clear();
    this.afterModify();
  }
  /** reflect a 2D point across the infinite line through a→b */
  private reflectPoint(x: number, y: number, a: THREE.Vector2, b: THREE.Vector2): { x: number; y: number } {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
    const px = a.x + t * dx, py = a.y + t * dy; // foot of perpendicular
    return { x: 2 * px - x, y: 2 * py - y };
  }
  /** a reflected COPY of an entity (fresh id) across the line a→b */
  private reflectEntity(e: ResolvedEntity, a: THREE.Vector2, b: THREE.Vector2): ResolvedEntity {
    const rp = (x: number, y: number) => this.reflectPoint(x, y, a, b);
    const id = newEntityId();
    const c = e.construction ? { construction: true } : {};
    if (e.type === "line") {
      const p1 = rp(e.x1, e.y1), p2 = rp(e.x2, e.y2);
      return { type: "line", id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, ...c };
    }
    if (e.type === "circle") {
      const ctr = rp(e.x, e.y);
      return { type: "circle", id, radius: e.radius, x: ctr.x, y: ctr.y, ...c };
    }
    if (e.type === "rectangle") {
      // a reflected axis-aligned rectangle stays axis-aligned: reflect the center
      const ctr = rp(e.x, e.y);
      return { type: "rectangle", id, width: e.width, height: e.height, x: ctr.x, y: ctr.y, ...c };
    }
    if (e.type === "arc") {
      // reflection flips orientation, so the through-point reflects too
      const p1 = rp(e.x1, e.y1), p2 = rp(e.x2, e.y2), m = rp(e.mx, e.my);
      return { type: "arc", id, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, mx: m.x, my: m.y, ...c };
    }
    if (e.type === "spline") {
      return { type: "spline", id, points: e.points.map((q) => rp(q.x, q.y)), ...c };
    }
    if (e.type === "bspline") {
      return { ...e, id, poles: e.poles.map((q) => rp(q.x, q.y)) };
    }
    if (e.type === "text") {
      const at = rp(e.x, e.y); // reflect the anchor; keep the string/style (glyphs aren't mirrored)
      return { ...e, id, x: at.x, y: at.y };
    }
    // point
    const q = rp((e as Extract<ResolvedEntity, { type: "point" }>).x, (e as Extract<ResolvedEntity, { type: "point" }>).y);
    return { type: "point", id, x: q.x, y: q.y, ...c };
  }


  private onPointerMove(e: PointerEvent) {
    // right-DRAG is camera pan (viewport TRUCK), not a menu gesture, the same
    // 5 px rule the viewport's own context-click guard uses
    if (this.rightDownAt && !this.rightDragged &&
      Math.hypot(e.clientX - this.rightDownAt.x, e.clientY - this.rightDownAt.y) > 5) {
      this.rightDragged = true;
    }
    if (this.active && this.tool === "project") {
      this.projectFlow.projectHover(e);
      return;
    }
    if (this.active && this.tool === "dimension") {
      this.dimFlow.dimensionHover(e);
      return;
    }
    if (this.active && MODIFY_TOOLS.has(this.tool)) {
      this.modifyFlow.modifyHover(e);
      return;
    }
    if (!this.active || this.tool === "select") {
      if (this.dragFrom) {
        if (!this.dragMoved) {
          const dx = e.clientX - this.dragStartClient.x, dy = e.clientY - this.dragStartClient.y;
          if (dx * dx + dy * dy < 16) return; // <4px: still a click, don't solve yet
          this.dragMoved = true;
        }
        const w = this.dragPointTarget(e);
        if (w) this.queueDrag(w);
        return;
      }
      if (this.moveDrag) {
        const raw = this.planePoint(e);
        if (!raw) return;
        const md = this.moveDrag;
        if (!md.started) {
          const dx = e.clientX - md.startClient.x, dy = e.clientY - md.startClient.y;
          if (dx * dx + dy * dy < 16) return; // <4px: still a click, not a move
          // projected geometry never body-drags (fixed reference); disarm so a
          // plain click still selects it in endDrag()
          if (this.modifyFlow.guardProjected(this.entities[md.idx])) {
            this.moveDrag = null;
            return;
          }
          md.started = true;
          // nothing has moved yet, so build the revert snapshot and the
          // neighbor-stretch set from the still-pristine positions
          this.dragSnapshot = JSON.parse(JSON.stringify(this.entities));
          const ent = this.entities[md.idx];
          if (ent) md.stretch = this.stretchTargets(md.idx, this.attachmentPoints(ent));
        }
        const dx = raw.x - md.last.x, dy = raw.y - md.last.y;
        md.last.copy(raw);
        const ent = this.entities[md.idx];
        if (ent) this.entities[md.idx] = translated(ent, dx, dy, ent.id);
        for (const s of md.stretch) s(dx, dy);
        this.refreshDragGeometry(); // curves only; dims/regions/candidates rebuilt on endDrag
        return;
      }
      if (this.boxDown && e.buttons & 1) {
        const b = this.boxDown;
        if (this.areaBox.visible || isAreaDrag(b.x, b.y, e.clientX, e.clientY)) {
          const { rect, mode } = dragBox(b.x, b.y, e.clientX, e.clientY);
          this.areaBox.show(rect.x0, rect.y0, rect.x1, rect.y1, mode);
          this.selectInBox(rect, mode, b.base);
        }
        return;
      }
      const hit = this.snapAt(e.clientX, e.clientY);
      this.showSnap(hit);
      if (this.tool === "select") {
        const raw = this.planePoint(e); // hover-highlight a profile area
        this.overlay.setHoverRegion(raw ? this.overlay.activeRegionAt(raw) : null);
      }
      return;
    }
    const hit = this.snapAt(e.clientX, e.clientY, e.ctrlKey);
    if (!hit) return;
    this.lastCursor.copy(hit.p);
    this.showSnap(hit);

    if (this.tool === "arc") {
      this.arcPreview(hit.p);
      return;
    }
    if (this.tool === "spline") {
      this.splinePreview(hit.p);
      return;
    }
    if (this.tool === "bspline") {
      this.bsplinePreview(hit.p);
      return;
    }
    if (this.tool === "polygon" || this.tool === "slot" || this.tool === "circle2" ||
        this.tool === "circle3" || this.tool === "centerRectangle" || this.tool === "rectangle3") {
      this.multiClickPreview(hit.p, e);
      return;
    }
    if (PATTERN_TOOLS.has(this.tool)) {
      this.patternMove(hit.p, e);
      return;
    }

    if (this.textBoxStart) {
      this.textBoxEnd = hit.p.clone();
      const s = this.textBoxStart, w = Math.abs(hit.p.x - s.x), h = Math.abs(hit.p.y - s.y);
      if (w > 0.5 && h > 0.5) {
        this.overlay.setPreview(curveObjects(
          [{ type: "rectangle", id: "__textbox__", width: w, height: h, x: (s.x + hit.p.x) / 2, y: (s.y + hit.p.y) / 2, construction: true }],
          this.plane, PREVIEW_COLOR,
        ));
      }
      return;
    }

    if (this.base) {
      const geom = this.computeGeometry(this.base, hit.p);
      this.dim.updateFromCursor(geom.dims);
      if (this.tool === "circle" && geom.entity?.type === "circle") {
        // The diameter is drawn through the centre along the drag, and its field
        // sits on that line where the eye already is.
        const c = this.base, r = geom.entity.radius;
        const u = hit.p.clone().sub(c);
        if (u.lengthSq() < 1e-12) u.set(1, 0);
        u.normalize();
        const diameter = curveObjects([{
          type: "line", id: "__diameter__", construction: true,
          x1: c.x - u.x * r, y1: c.y - u.y * r, x2: c.x + u.x * r, y2: c.y + u.y * r,
        }], this.plane, PREVIEW_COLOR);
        const at = this.viewport.projectToScreen(this.plane.to3D(c.x + (u.x * r) / 2, c.y + (u.y * r) / 2));
        this.dim.positionCentred(at.x, at.y);
        this.overlay.setPreview([geom.preview, ...diameter]);
      } else {
        this.dim.position(e.clientX, e.clientY);
        this.overlay.setPreview([geom.preview]); // only the rubber-band redraws
      }
    } else {
      this.overlay.setPreview([]);
    }
  }

  private onKey(e: KeyboardEvent) {
    // The dim box auto-focuses while drawing, so Esc in it must still cancel.
    const escInOwnDim = e.key === "Escape" && this.dim.isActive && this.dim.ownsTarget(e.target);
    if (!escInOwnDim && isEditableTarget(e.target)) return; // typing in a dim/text field, not a shortcut
    // a pattern being placed/edited: Delete removes it, Esc keeps it as-is
    if (this.patternFlow.hasPending()) {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.patternFlow.deletePending();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.patternFlow.cancelPending();
        return;
      }
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      // A selected dimension is more specific than the entity selection.
      if (this.dims.deleteSelected()) {
        e.preventDefault();
        return;
      }
      if (this.tool === "select" && this.deleteSelectedPole()) {
        e.preventDefault();
        return;
      }
      if (this.tool === "select" && this.selected.size) {
        e.preventDefault();
        this.deleteSelected();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Which rung of the stack this press lands on is decided next door, where
      // the ORDER can be tested without a canvas, see escapeLayers.ts.
      const action = sketchEscapeAction({
        offsetPick: this.modifyFlow.offsetting,
        dragging: !!(this.dragFrom || this.moveDrag),
        pendingGeometry:
          !!this.base || !!this.arcStart || this.modifyFlow.filletArmed || this.splinePts.length > 0 ||
          this.clickPts.length > 0 || this.dimFlow.picking || !!this.dimFlow.plan ||
          this.constraintTools.hasPending(),
        selection: this.selected.size > 0,
        tool: this.tool,
        overlay: escapeClaimed(),
      });
      if (action === "none") return;
      if (action === "cancel-offset") { this.modifyFlow.cancelOffset(); return; }
      if (action === "cancel-drag") {
        // cancel an in-progress drag: revert geometry to its pre-drag positions
        if (this.dragSnapshot) this.entities = this.dragSnapshot;
        this.dragSnapshot = null;
        this.dragFrom = null;
        this.dragAnchors = [];
        this.showSnap(null);
        this.moveDrag = null;
        this.pendingDrag = null;
        this.conflict = false;
        this.refreshActive();
        this.onState?.();
        return;
      }
      if (action === "cancel-geometry") {
        this.base = null;
        this.chainStart = null;
        this.arcStart = null;
        this.arcEnd = null;
        this.modifyFlow.setFilletFirst(null);
        this.splinePts = [];
        this.clickPts = [];
        // in-progress dimension: picks AND an open value box both die here (the
        // old code listed only the first-point slot, which is why Escape could
        // leave a dim box stranded on screen). The tool stays armed.
        this.dimFlow.resetDimPicks();
        this.constraintTools.resetPending();
        this.dim.hide();
        this.overlay.setPreview([]);
      } else if (action === "clear-selection") {
        this.selected.clear();
        this.refreshActive();
      } else if (action === "arm-select") {
        this.setTool("select");
      } else {
        // Nothing left to cancel: Esc commits the sketch rather than discarding minutes of
        // work, and stops here or the global handler clears the model selection too.
        e.stopPropagation();
        this.finish(true);
      }
      return;
    }
    if (e.key === "Enter") {
      if (this.patternFlow.hasPending()) {
        e.preventDefault();
        this.commitPattern();
        return;
      }
      if (this.tool === "spline" && this.splinePts.length) {
        e.preventDefault();
        this.finishSpline();
        return;
      }
      if (this.tool === "bspline" && this.splinePts.length) {
        e.preventDefault();
        this.finishBspline(false);
        return;
      }
      if (this.base) {
        e.preventDefault();
        this.commitFromCursor(this.lastCursor);
        return;
      }
    }
    // tool shortcuts inside the sketch
    const k = e.key.toLowerCase();
    // Q and E fall through to the global keymap (Press/Pull, Extrude).
    if (k === "l") this.setTool("line");
    else if (k === "r") this.setTool("rectangle");
    else if (k === "c") this.setTool("circle");
    else if (k === "a") this.setTool("arc");
    else if (k === "t") this.setTool("trim");
    else if (k === "o") this.setTool("offset");
    else if (k === "p") this.setTool("project");
  }

  // --- geometry per tool -------------------------------------------------
  private computeGeometry(a: THREE.Vector2, cursor: THREE.Vector2) {
    if (this.tool === "rectangle") {
      let w = Math.abs(cursor.x - a.x);
      let h = Math.abs(cursor.y - a.y);
      const sx = Math.sign(cursor.x - a.x) || 1;
      const sy = Math.sign(cursor.y - a.y) || 1;
      if (this.dim.isUserDriven("width")) w = this.dim.getValue("width") ?? w;
      if (this.dim.isUserDriven("height")) h = this.dim.getValue("height") ?? h;
      const cx = a.x + (sx * w) / 2;
      const cy = a.y + (sy * h) / 2;
      const ent: ResolvedEntity = { type: "rectangle", id: "", width: w, height: h, x: cx, y: cy };
      const dims: Record<string, number> = { width: w, height: h };
      return { dims, preview: this.entityCurve(ent), entity: ent };
    }
    if (this.tool === "circle") {
      let dia = 2 * a.distanceTo(cursor);
      if (this.dim.isUserDriven("diameter")) dia = this.dim.getValue("diameter") ?? dia;
      const ent: ResolvedEntity = { type: "circle", id: "", radius: dia / 2, x: a.x, y: a.y };
      const dims: Record<string, number> = { diameter: dia };
      return { dims, preview: this.entityCurve(ent), entity: ent };
    }
    // line
    let len = a.distanceTo(cursor);
    let ang = (Math.atan2(cursor.y - a.y, cursor.x - a.x) * 180) / Math.PI;
    const typedLen = this.dim.isUserDriven("length");
    const typedAng = this.dim.isUserDriven("angle");
    if (typedLen) len = this.dim.getValue("length") ?? len;
    if (typedAng) ang = this.dim.getValue("angle") ?? ang;
    const ar = (ang * Math.PI) / 180;
    // The snapped point as is: a round trip through polar lands a grid corner at
    // 5.999995816, which onLattice() rejects. Only typed values are reconstructed.
    const end = typedLen || typedAng
      ? new THREE.Vector2(a.x + Math.cos(ar) * len, a.y + Math.sin(ar) * len)
      : cursor.clone();
    const ent: ResolvedEntity = { type: "line", id: "", x1: a.x, y1: a.y, x2: end.x, y2: end.y };
    const dims: Record<string, number> = { length: len, angle: ang };
    return { dims, preview: this.entityCurve(ent), entity: ent };
  }

  /** A same-spot second click (or a typed 0) leaves nothing to draw. Refused
   *  rather than creating a hidden zero-size entity, which used to surface only
   *  as an unexplained red badge in History (SK-5). The other click-built
   *  shapes (circle2/3, slot, centerRectangle, rectangle3) already guard this
   *  at their own commit point; this is the one the two-corner drag tools share. */
  private isDegenerate(e: ResolvedEntity): boolean {
    if (e.type === "rectangle") return e.width < 1e-4 || e.height < 1e-4;
    if (e.type === "circle") return e.radius < 1e-4;
    if (e.type === "line") return Math.hypot(e.x2 - e.x1, e.y2 - e.y1) < 1e-4;
    return false;
  }

  private commitFromCursor(cursor: THREE.Vector2) {
    if (!this.base) return;
    const { entity } = this.computeGeometry(this.base, cursor);
    if (this.isDegenerate(entity)) {
      toast("Too small to draw, click somewhere else to set its size");
      return;
    }
    if (this.constructionMode) entity.construction = true;
    entity.id = newEntityId(); // stamp a stable id (computeGeometry left it "")
    this.entities.push(entity);
    if (entity.type === "rectangle") {
      this.lockTypedDims(entity, { width: this.dim.isUserDriven("width"), height: this.dim.isUserDriven("height") });
    } else if (entity.type === "circle") {
      this.lockTypedDims(entity, { diameter: this.dim.isUserDriven("diameter") });
    }
    if (this.tool === "line" && entity.type === "line") {
      const end = new THREE.Vector2(entity.x2, entity.y2);
      // clicked back on the start point → close the loop and end the chain
      const closing = this.chainStart != null && end.distanceTo(this.chainStart) < 1e-3;
      // Infer horizontal or vertical. The closing segment was not aimed, so it gets
      // exact axes only, without the three degree guess. A typed angle is preferred.
      if (!this.dim.isUserDriven("angle")) {
        this.inferLineConstraint(entity, closing ? 0 : INFER_TOL_DEG);
      }
      if (closing) {
        this.base = null;
        this.chainStart = null;
        this.dim.hide();
      } else {
        this.base = new THREE.Vector2(entity.x2, entity.y2); // snapped endpoint
        this.showDimFields();
      }
    } else {
      if (entity.type === "circle") this.inferConcentric(entity);
      this.base = null;
      this.dim.hide();
    }
    this.refreshActive(); // entity list changed: rebuild active curves + snaps
    this.overlay.setPreview([]);
    this.requestSolve(); // re-solve if any constraints exist (updates DOF colour)
    this.onState?.();
  }

  /** Record horizontal/vertical on a freshly drawn line (mainstream MCAD's
   *  auto-constrain). The grid decides when it can; otherwise a few degrees of
   *  tolerance does. See inferLine.ts for why the order matters. */
  private inferLineConstraint(e: ResolvedEntity, tolDeg = INFER_TOL_DEG) {
    if (e.type !== "line") return;
    const dir = inferLineDirection(
      e.x1, e.y1, e.x2, e.y2,
      this.gridSnap ? this.snapStep() : 0,
      tolDeg,
    );
    if (dir === "horizontal") {
      e.y2 = e.y1; // exactly horizontal
      this.constraints.push({ type: "horizontal", line: e.id });
    } else if (dir === "vertical") {
      e.x2 = e.x1; // exactly vertical
      this.constraints.push({ type: "vertical", line: e.id });
    }
  }

  /** A typed size during creation (the live W/H/⌀ fields) becomes the same
   *  constraint the Dimension tool would create by picking that geometry, so it
   *  is genuinely locked rather than a cosmetic label: a rectangle's typed width
   *  is a p2pDistance across its edge, exactly what picking that edge with the
   *  Dimension tool makes (see dimensionTool.ts resolveSingle's edge case), and
   *  a typed diameter is a `diameter` constraint on the circle. Without this, a
   *  later unrelated dimension elsewhere in the sketch could silently resize the
   *  "50 mm" the user just typed, with no conflict warning (SK-2).
   *
   *  Slot and polygon have no such equivalent: the Dimension tool itself cannot
   *  pick a slot's length/width or a polygon's radius (dimRefPoints/resolveSingle
   *  expose no operand for them), so there is no real constraint to switch their
   *  typed values to; they keep their existing cosmetic-only behaviour. */
  private lockTypedDims(e: ResolvedEntity, typed: { width?: boolean; height?: boolean; diameter?: boolean }) {
    if (e.type === "rectangle") {
      if (typed.width) this.constraints.push({ type: "p2pDistance", e1: e.id, p1: 0, e2: e.id, p2: 1, value: e.width });
      if (typed.height) this.constraints.push({ type: "p2pDistance", e1: e.id, p1: 1, e2: e.id, p2: 2, value: e.height });
    } else if (e.type === "circle" && typed.diameter) {
      this.constraints.push({ type: "diameter", circle: e.id, value: e.radius * 2 });
    }
  }

  /** A circle whose centre landed on another circle's or arc's centre keeps it there. */
  private inferConcentric(e: ResolvedEntity) {
    if (e.type !== "circle") return;
    for (const other of this.entities) {
      if (other.id === e.id) continue;
      const k = curveKind(other);
      if (k !== "circle" && k !== "arc") continue;
      const r = asRound(other);
      if (r && Math.hypot(r.x - e.x, r.y - e.y) < 1e-6) {
        this.constraints.push({ type: "concentric", c1: other.id, c2: e.id });
        return;
      }
    }
  }

  private showDimFields() {
    const defs =
      this.tool === "rectangle"
        ? [{ name: "width", label: "W" }, { name: "height", label: "H" }]
        : this.tool === "circle"
          ? [{ name: "diameter", label: "Diameter", icon: "diameter" }]
          : [
              { name: "length", label: "L" },
              { name: "angle", label: "Angle", icon: "angle", kind: "angle" as const },
            ];
    this.dim.show(defs, () => this.commitFromCursor(this.lastCursor));
  }

  // --- snapping + rendering ---------------------------------------------
  private snapAt(clientX: number, clientY: number, noSnap = false) {
    if (this.planeTooEdgeOn()) return null;
    const world = this.viewport.screenToPlane(clientX, clientY, this.plane.plane);
    if (!world) return null;
    const p2d = this.plane.to2D(world);
    // Hold Ctrl to suppress snapping for fine placement (raw cursor position).
    if (noSnap) return { p: p2d, kind: "free" as SnapKind, world, guides: [] as SnapGuide[], label: undefined };
    const res = snap(
      p2d,
      this.candidates, // cached; rebuilt only when entities change
      (q) => this.viewport.projectToScreen(this.plane.to3D(q.x, q.y)),
      this.gridSnap ? this.snapStep() : 0,
    );
    return {
      p: res.point,
      kind: res.kind,
      world: this.plane.to3D(res.point.x, res.point.y),
      guides: res.guides,
      label: res.label,
    };
  }

  /** The grid spacing currently on screen, which is what the cursor snaps to.
   *  Measured at the plane origin, the same place the grid is drawn from. */
  private snapStep(): number {
    return snapLatticeStep(this.planeMmPerPx());
  }

  private showSnap(
    hit: { kind: SnapKind; world: THREE.Vector3; p?: THREE.Vector2; guides?: SnapGuide[]; label?: string | undefined } | null,
  ) {
    // The guides go up or down with the snap itself: a line left standing after
    // the cursor has moved off the row it named is a claim about where the next
    // click will land, and it would be a false one.
    this.overlay.setGuides(
      hit?.p && hit.guides?.length
        ? hit.guides.map((g) => [g.from, hit.p!] as const)
        : [],
      this.plane,
      this.planeMmPerPx(),
    );
    if (!hit || !showsSnapMarker(this.tool, hit.kind, hit.label)) {
      this.overlay.setSnap(null);
      this.snapWorld = null;
      this.snapTag.hide();
      return;
    }
    this.overlay.setSnap(hit.world, hit.kind, this.viewport.camera);
    if (hit.label) this.snapTag.show(hit.label, this.viewport.projectToScreen(hit.world));
    else this.snapTag.hide();
    this.snapWorld = hit.world.clone();
    this.snapScaleSeen = 0; // a new point: size it now rather than next frame
    this.updateSnapScale();
  }

  /** The snap ring is a screen size in world geometry, so it follows zoom too. */
  private snapWorld: THREE.Vector3 | null = null;
  private snapScaleSeen = 0;
  private snapTag = new SnapTag();
  private updateSnapScale() {
    const at = this.snapWorld;
    if (!at) return;
    const mm = this.viewport.pixelWorldSize(at);
    if (!(mm > 0) || !Number.isFinite(mm)) return;
    const last = this.snapScaleSeen;
    if (last > 0 && mm > last / DIM_SCALE_TOL && mm < last * DIM_SCALE_TOL) return;
    this.snapScaleSeen = mm;
    this.overlay.setSnapScale(mm * SNAP_MARKER_PX);
    this.viewport.requestRender();
  }

  /** MCAD-style state color: over-constrained/conflict = red, fully
   * constrained (dof 0) = white ("fully defined"), under-constrained = blue.
   * dof < 0 means no solve has run yet (treat as under-constrained). */
  private activeColor(): number {
    return this.conflict ? 0xff4444 : this.lastDof === 0 ? 0xffffff : CURVE_COLOR;
  }

  /** All pattern definitions including the one being placed (for live preview). */
  private allPatterns(): SketchPattern[] {
    const pending = this.patternFlow.pending;
    return pending ? [...this.patterns, pending] : this.patterns;
  }

  /** Derived (copy) entities from every pattern, render/region only, never edited
   *  or snapped individually. Mirrors the build/persist expansion. */
  private derivedEntities(): ResolvedEntity[] {
    const pats = this.allPatterns();
    if (!pats.length) return [];
    const params = this.store?.document.parameters ?? {};
    const byId = new Map(this.entities.map((e) => [e.id, e]));
    const out: ResolvedEntity[] = [];
    for (const pat of pats) out.push(...expandPattern(pat, byId, params));
    return out;
  }

  private activeCurves(derived: ResolvedEntity[]): THREE.Object3D[] {
    const objs: THREE.Object3D[] = [];
    const lit = this.relHover;
    if (this.selected.size || lit.size) {
      // Three layers, and the hover is on top: it is transient and answers a
      // question being asked right now, so it is preferred over a selection that may
      // have been sitting there since before the panel was opened.
      const normal = this.entities.filter((e) => !this.selected.has(e.id) && !lit.has(e.id));
      const chosen = this.entities.filter((e) => this.selected.has(e.id) && !lit.has(e.id));
      const hovered = this.entities.filter((e) => lit.has(e.id));
      if (normal.length) objs.push(...curveObjects(normal, this.plane, this.activeColor()));
      if (chosen.length) objs.push(...curveObjects(chosen, this.plane, SELECT_COLOR, true));
      if (hovered.length) objs.push(...curveObjects(hovered, this.plane, PREVIEW_COLOR, true));
    } else {
      objs.push(...curveObjects(this.entities, this.plane, this.activeColor()));
    }
    objs.push(...this.polygonObjects());
    if (this.dimsVisible) {
      this.cdims = constraintDims(this.entities, this.constraints);
      objs.push(...dimensionLineObjects(this.entities, this.plane, this.cdims.flatMap((d) => d.lines)));
    } else {
      this.cdims = [];
    }
    if (derived.length) objs.push(...curveObjects(derived, this.plane, this.activeColor()));
    objs.push(...this.faceAnchorMarkers());
    return objs;
  }

  /** The face's centre, hole centres, corners and side middles, at priorities 70-76:
   *  under anything drawn, over a projected polyline's samples (60). */
  private faceAnchorCandidates(): SnapCandidate[] {
    const out: SnapCandidate[] = footprintAnchors(this.footprint).map((p) => ({
      p,
      kind: "center" as SnapKind,
      priority: 70,
      label: "Face Center",
    }));
    const { corners, sides } = boundaryAnchors(this.footprintEdges);
    for (const p of corners) out.push({ p, kind: "endpoint", priority: 76, label: "Face Corner" });
    for (const p of sides) out.push({ p, kind: "midpoint", priority: 72, label: "Edge Midpoint" });
    return out;
  }

  /** A dim cross on each face anchor, visible before the cursor is close enough to snap. */
  private faceAnchorMarkers(): THREE.Object3D[] {
    const { corners, sides } = boundaryAnchors(this.footprintEdges);
    const pts = [...footprintAnchors(this.footprint), ...corners, ...sides];
    if (!pts.length) return [];
    return curveObjects(
      pts.map((p, i) => ({ type: "point" as const, id: `__face${i}`, x: p.x, y: p.y })),
      this.plane,
      FACE_ANCHOR_COLOR,
    );
  }

  private entityCurve(e: ResolvedEntity): THREE.Object3D {
    // curveObjects yields exactly one object per input entity, so [0] is present
    const obj = curveObjects([e], this.plane, PREVIEW_COLOR)[0];
    if (!obj) throw new Error("entityCurve: curveObjects returned no object");
    return obj;
  }

  // --- modify tools: trim + fillet -------------------------------------
  private pickTol(): number {
    return this.planeMmPerPx() * 9;
  }
  /** raw (unsnapped) cursor point on the sketch plane */
  private planePoint(e: MouseEvent): THREE.Vector2 | null {
    return this.planePointAt(e.clientX, e.clientY);
  }
  /** The screen to plane conversion; use it rather than scaling pixels by mm-per-pixel. */
  private planePointAt(clientX: number, clientY: number): THREE.Vector2 | null {
    // Edge-on, a pixel is worth metres (planeGraze).
    if (this.planeTooEdgeOn()) return null;
    const w = this.viewport.screenToPlane(clientX, clientY, this.plane.plane);
    return w ? this.plane.to2D(w) : null;
  }

  /** Has the view rolled the sketch plane too far edge-on to draw on? */
  planeTooEdgeOn(): boolean {
    const d = this.viewport.viewDirection();
    const n = this.plane.plane.normal;
    return tooEdgeOn([d.x, d.y, d.z], [n.x, n.y, n.z]);
  }
  // --- selection delete (select tool) -----------------------------------
  /** Remove the selected entities, prune now-dangling constraints, then rebuild
   *  + re-solve via the shared modify tail. */
  private deleteSelected() {
    if (!this.selected.size) return;
    this.entities = this.entities.filter((en) => !this.selected.has(en.id));
    this.selected.clear();
    dismissContextMenu(); // the Delete key can fire while the right-click menu is open
    this.afterModify();
  }

  /** Right-click in select mode: select the entity under the cursor (if any) and
   *  offer Delete. Leaves camera navigation alone when nothing is hit/selected. */
  private onContextMenu(e: MouseEvent) {
    if (!this.active) return;
    // a right-DRAG panned the camera, don't turn its release into a menu
    const dragged = this.rightDragged;
    this.rightDownAt = null;
    this.rightDragged = false;
    if (dragged) return;
    if (this.tool === "dimension") { this.openDimensionMenu(e); return; }
    if (this.tool === "offset") { this.modifyFlow.openOffsetMenu(e); return; }
    if (this.tool !== "select") return;
    const raw = this.planePoint(e);
    const idx = raw ? pickEntity(this.entities, raw, this.pickTol()) : -1;
    const hit = idx >= 0 ? this.entities[idx] : undefined;
    if (hit) {
      const id = hit.id;
      if (!this.selected.has(id)) { this.selected = new Set([id]); this.refreshActive(); }
    }
    const gp = raw ? this.pickPoint(raw) : null;
    const poleOf = gp && gp.pole >= 0 ? this.entities[gp.idx] : undefined;
    if (gp && poleOf?.type === "bspline" && this.selected.has(poleOf.id)) {
      this.selectedPole = { id: poleOf.id, k: gp.pole };
      this.refreshActive();
    }
    if (!this.selected.size) {
      // Nothing under the cursor and nothing already selected: a right-drag
      // still orbits (the `dragged` check above), but a plain click has no
      // curve to act on. Leaving the event unclaimed used to mean the next
      // idle Escape (someone dismissing a menu they expected to see) fell
      // straight through escapeLayers to "close": a miss by a few pixels on a
      // curve's rim could exit the sketch with no warning. Offering Exit
      // Sketching here, instead of nothing, gives the click a real answer and
      // makes leaving that way a click, never an accident.
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [{ label: "Exit Sketching", onClick: () => this.finish(true) }]);
      return;
    }
    e.preventDefault();
    const n = this.selected.size;
    const linked = this.modifyFlow.selectedProjectedIds().size;
    const chosen = this.entities.filter((x) => this.selected.has(x.id));
    const bsplines = chosen.filter((x): x is BsplineEntity => x.type === "bspline");
    const constraintItems = this.constraintOptions(raw);
    const items: CtxItem[] = [
      ...(linked
        ? [{ label: linked > 1 ? `Break Link (${linked})` : "Break Link", onClick: () => this.modifyFlow.breakSelectedLinks() }]
        : []),
      ...(chosen.some((x) => x.type === "spline")
        ? [{ label: "Edit as Control Points", onClick: () => this.convertSelectedSplines() }]
        : []),
      ...(bsplines.length
        ? [
            ...degreeChoices(bsplines).map((c) => ({ ...c, onClick: () => this.reshapeSelectedBsplines({ degree: c.degree }) })),
            bsplines.every((x) => x.closed)
              ? { label: "Open Curve", onClick: () => this.reshapeSelectedBsplines({ closed: false }) }
              : { label: "Close Curve", disabled: bsplines.some((x) => x.poles.length < 3), onClick: () => this.reshapeSelectedBsplines({ closed: true }) },
            ...(this.selectedPole && bsplines.some((x) => x.id === this.selectedPole?.id)
              ? [{ label: "Delete Control Point", onClick: () => { this.deleteSelectedPole(); } }]
              : []),
            { separator: true, label: "" },
          ]
        : []),
      ...(constraintItems.length
        ? [...constraintItems.map((o) => ({ label: o.label, onClick: o.apply })), { separator: true, label: "" }]
        : []),
      { label: n > 1 ? `Delete ${n} entities` : "Delete", danger: true, onClick: () => this.deleteSelected() },
    ];
    contextMenu(e.clientX, e.clientY, items);
  }

  /** Dimension overrides picks cannot express. "Pick Circle/Arc Tangent" arms for the next pick only. */
  private openDimensionMenu(e: MouseEvent) {
    e.preventDefault();
    const plan = this.dimFlow.plan;
    // radius/diameter only means something while a lone round is picked
    const lone = this.dimFlow.loneRound;
    const isDia = plan?.kind === "diameter";
    const items: CtxItem[] = [
      {
        label: "Pick Circle/Arc Tangent", checked: this.dimFlow.tangentArmed,
        onClick: () => {
          const armed = this.dimFlow.toggleTangent();
          setPrompt(armed
            ? "Tangent pick armed, click a circle or arc to measure to its EDGE"
            : "Tangent pick cleared");
        },
      },
      { separator: true, label: "" },
      {
        label: "Radius", checked: lone && !isDia, disabled: !lone,
        onClick: () => this.setDimRoundPref("radius"),
      },
      {
        label: "Diameter", checked: lone && isDia, disabled: !lone,
        onClick: () => this.setDimRoundPref("diameter"),
      },
      { separator: true, label: "" },
      {
        label: "Driven (reference)", checked: this.referenceMode,
        onClick: () => { this.setReferenceDim(!this.referenceMode); this.onState?.(); },
      },
      { separator: true, label: "" },
      { label: "OK", disabled: !plan, onClick: () => { if (this.dimFlow.plan) this.dimFlow.commitDim(); } },
      { label: "Cancel", onClick: () => this.dimFlow.cancelDim() },
    ];
    contextMenu(e.clientX, e.clientY, items);
  }

  private setDimRoundPref(pref: "radius" | "diameter") {
    this.dimFlow.setRoundPref(pref);
    this.dimFlow.refreshDimPlan();
    const plan = this.dimFlow.plan;
    if (plan) setPrompt(plan.hint);
  }
  /** add a persistent geometric constraint and re-solve (the solver maintains
   *  all constraints together, not just the one you applied). Delegates to
   *  ConstraintTools (see constraintTools.ts), which owns the 9 click flows. */
  private constraintClick(p: THREE.Vector2) {
    this.constraintTools.click(p);
  }

  /** Constraint options for the CURRENT canvas selection (1-2 entities), each
   *  already wired to add its constraint and re-solve. `at`, a click position,
   *  resolves to the SPECIFIC point nearest it and pins that point to whichever
   *  selected entity owns it, so a right-click on one corner of a selected
   *  rectangle can offer Coincident for THAT corner instead of refusing for
   *  ambiguity (see ConstraintTools.applicable). Shared by ToolRail's Constrain
   *  popup (no `at`) and onContextMenu (`at` = the click), so the two lists can
   *  never drift apart (SK-3). */
  constraintOptions(at?: THREE.Vector2 | null): ConstraintOption[] {
    const ids = [...this.selected];
    if (!ids.length || ids.length > 2) return [];
    const gp = at ? this.constraintTools.resolvePoint(at) : null;
    const picks = ids.map((id) => (gp && gp.id === id ? { id, p: gp.idx } : { id }));
    return this.constraintTools.applicable(picks);
  }

  /** Drop constraints on entities that are gone or the wrong type. The switch is
   *  exhaustive so a new constraint type is a compile error, not a silent drop. */
  private pruneConstraints() {
    const ids = (pred: (e: ResolvedEntity) => boolean) =>
      new Set(this.entities.filter(pred).map((e) => e.id));
    const lineIds = ids((e) => curveKind(e) === "line");
    const circleIds = ids((e) => curveKind(e) === "circle");
    // entities that own a center (circle/arc), for concentric/radius/equalRadius
    const roundIds = ids((e) => { const k = curveKind(e); return k === "circle" || k === "arc"; });
    const curveIds = ids((e) => curveKind(e) !== undefined);
    // entities that own an addressable endpoint (line/arc/spline/point; projected line/arc/poly)
    const endIds = ids(
      (e) =>
        e.type === "line" || e.type === "arc" || e.type === "spline" || e.type === "bspline" || e.type === "point" ||
        (e.type === "projected" && e.curve.kind !== "circle"),
    );
    // a pole index beyond a control-point spline's poles names nothing
    const polesOf = new Map(this.entities.flatMap((e) => (e.type === "bspline" ? [[e.id, e.poles.length] as const] : [])));
    const at = (id: string, p: number) => { const n = polesOf.get(id); return n === undefined || poleOfRef(p, n) >= 0; };
    // entities exposing at least one dimensionable reference point (p2p/p2l/fix targets)
    const refIds = ids((e) => dimRefPoints(e).length > 0);
    const rectIds = ids((e) => e.type === "rectangle");
    // A line operand may be a rectangle edge ("<rectId>~<k>").
    const hasLineOperand = (id: string): boolean => {
      const t = id.indexOf("~");
      if (t < 0) return lineIds.has(id);
      const k = Number(id.slice(t + 1));
      return rectIds.has(id.slice(0, t)) && Number.isInteger(k) && k >= 0 && k <= 3;
    };
    this.constraints = this.constraints.filter((c) => {
      switch (c.type) {
        case "horizontal": case "vertical": case "distance": return hasLineOperand(c.line);
        case "parallel": case "perpendicular": case "equal": case "collinear": case "angle":
          return hasLineOperand(c.l1) && hasLineOperand(c.l2);
        case "diameter": return roundIds.has(c.circle);
        case "tangent": return hasLineOperand(c.line) && circleIds.has(c.circle);
        case "tangent2": return curveIds.has(c.a) && curveIds.has(c.b);
        case "equalRadius": return roundIds.has(c.a) && roundIds.has(c.b);
        case "coincident": return endIds.has(c.e1) && endIds.has(c.e2) && at(c.e1, c.p1) && at(c.e2, c.p2);
        case "concentric": return roundIds.has(c.c1) && roundIds.has(c.c2);
        case "midpoint": return endIds.has(c.e) && at(c.e, c.p) && hasLineOperand(c.line);
        case "symmetric": return endIds.has(c.e1) && endIds.has(c.e2) && at(c.e1, c.p1) && at(c.e2, c.p2) && hasLineOperand(c.line);
        case "radius": return roundIds.has(c.e);
        case "p2pDistance": return refIds.has(c.e1) && refIds.has(c.e2) && at(c.e1, c.p1) && at(c.e2, c.p2);
        case "p2lDistance": return refIds.has(c.e) && at(c.e, c.p) && hasLineOperand(c.line);
        // rim (edge-to-edge) dims, a round operand is a circle OR an arc
        case "radialGap": return roundIds.has(c.inner) && roundIds.has(c.outer);
        case "c2cDistance": return roundIds.has(c.c1) && roundIds.has(c.c2);
        case "c2lDistance": return roundIds.has(c.circle) && hasLineOperand(c.line);
        case "p2cDistance": return refIds.has(c.e) && at(c.e, c.p) && roundIds.has(c.circle);
        case "fix": return refIds.has(c.e) && at(c.e, c.p);
        // Shrink the pairs; drop the offset only when none remain.
        case "offset": {
          c.pairs = c.pairs.filter(
            (pr) =>
              (hasLineOperand(pr.src) && hasLineOperand(pr.cpy)) ||
              (roundIds.has(pr.src) && roundIds.has(pr.cpy)),
          );
          return c.pairs.length > 0;
        }
        // unreachable while the switch is exhaustive; keeps (rather than drops)
        // a variant tsc failed to flag
        default: return c satisfies never;
      }
    });
  }

  /** Drop vanished pattern sources, and a pattern left with none. */
  private prunePatterns() {
    if (!this.patterns.length) return;
    const ids = new Set(this.entities.map((e) => e.id));
    let droppedCount = 0;
    this.patterns = this.patterns.filter((pat) => {
      if (!("sources" in pat)) return true; // preset patterns (hex/honeycomb/boltCircle/gridHoles) have no sources
      const survivors = pat.sources.filter((id) => ids.has(id));
      if (survivors.length === 0) { droppedCount++; return false; }
      pat.sources = survivors;
      return true;
    });
    if (droppedCount > 0) {
      setPrompt(
        droppedCount === 1
          ? "A pattern was removed: its source entity no longer exists"
          : `${droppedCount} patterns were removed: their source entities no longer exist`,
      );
    }
  }

  /** Common tail for modify ops: prune now-dangling constraints + patterns, rebuild, re-solve. */
  private afterModify() {
    this.pruneConstraints();
    this.prunePatterns();
    this.refreshActive();
    this.overlay.setPreview([]);
    this.requestSolve();
  }

  // --- in-sketch undo -------------------------------------------------------

  private snapshot(): SketchSnapshot {
    return cloneSnapshot({
      entities: this.entities,
      constraints: this.constraints,
      patterns: this.patterns,
    });
  }

  private restore(s: SketchSnapshot) {
    const c = cloneSnapshot(s);
    this.entities = c.entities;
    this.constraints = c.constraints;
    this.patterns = c.patterns;
  }

  /** Re-arm the history baseline. Called when the state SETTLES after a solve,
   *  and by the derived paths to make their own changes invisible to
   *  bankIfChanged. */
  private armPreEdit() {
    if (this.active) this.history.arm(this.snapshot());
  }

  /** Bank an undo step if the sketch changed. Called from requestSolve(), where every
   *  user edit ends. Solver write-backs never call it, derived updates re-arm the
   *  baseline first, and drags bank one step in endDrag. */
  private bankIfChanged() {
    if (this.active) this.history.bankIfChanged(this.snapshot());
  }

  /** A finished drag as one undo step, reusing the Esc-revert snapshot. */
  private bankDrag() {
    const before = this.dragSnapshot;
    this.dragSnapshot = null; // committed, drop the revert buffer
    if (!before || !this.active) return;
    this.history.bankBefore(
      { entities: before, constraints: this.constraints, patterns: this.patterns },
      this.snapshot(),
    );
  }

  get canUndoSketch(): boolean { return this.history.canUndo; }
  get canRedoSketch(): boolean { return this.history.canRedo; }

  /** True whenever a sketch is open, even with nothing to undo: the document undo would drop the sketch. */
  undoEdit(): boolean {
    if (!this.active) return false;
    const prev = this.history.undo(this.snapshot());
    if (!prev) { setPrompt("Nothing left to undo in this sketch"); return true; }
    this.applyHistory(prev);
    return true;
  }

  redoEdit(): boolean {
    if (!this.active) return false;
    const next = this.history.redo(this.snapshot());
    if (!next) { setPrompt("Nothing to redo in this sketch"); return true; }
    this.applyHistory(next);
    return true;
  }

  /** Restore a history state and settle. Any half-finished tool gesture is
   *  dropped: its indices refer to the geometry we just replaced. */
  private applyHistory(s: SketchSnapshot) {
    this.restore(s);
    this.selected.clear();
    this.base = null;
    this.chainStart = null;
    this.arcStart = null;
    this.arcEnd = null;
    this.splinePts = [];
    this.clickPts = [];
    this.modifyFlow.reset();
    this.dim.hide();
    this.overlay.setPreview([]);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  /** Mark the sketch dirty and kick the solve pump. Coalesces many requests
   *  into one in-flight solve so the (single, shared) WASM wrapper is never
   *  re-entered, and stale results never clobber newer geometry. */
  private requestSolve() {
    this.bankIfChanged();
    this.solveDirty = true;
    void this.pump();
  }

  /** The one and only path that touches the solver. Serializes drag solves and
   *  constraint/dimension solves through a single in-flight lock. */
  private async pump() {
    if (this.solveBusy || this.solverDead) return;
    this.solveBusy = true;
    try {
      while (this.active && (this.pendingDrag || this.solveDirty)) {
        if (this.pendingDrag) {
          // no entityVersion guard here: a drag never adds/removes entities, so
          // the entity list can't change underneath this solve (unlike a draw).
          const d = this.pendingDrag;
          this.pendingDrag = null;
          const r = await compileAndSolve(this.entities, this.constraints, d);
          if (!this.active || !this.dragFrom) break; // drag ended/cancelled mid-solve
          this.conflict = r.conflicts.length > 0;
          this.conflictIdx = parseConflictIdx(r.conflicts);
          this.overIdx = parseConflictIdx(r.overDefined);
          if (!this.conflict) this.entities = r.entities;
          this.lastDof = r.dof;
          if (r.dragRefused) {
            // Keep the anchor on the fixed point, or the next search grabs another point.
            if (!this.dragRefusedToast) {
              this.dragRefusedToast = true;
              toast(r.dragRefused === "projected" ? PROJECTED_FIXED_MSG : "That point is fixed, delete its Fix constraint to move it");
            }
          } else if (this.dragFrom) {
            this.dragFrom.set(d.toX, d.toY); // track grabbed pt
          }
          this.refreshDragGeometry(); // curves only; dims/candidates rebuilt on endDrag
        } else {
          this.solveDirty = false;
          if (this.constraints.length === 0) { this.lastDof = -1; this.conflict = false; continue; }
          const ver = this.entityVersion;
          const r = await compileAndSolve(this.entities, this.constraints);
          if (!this.active) break;
          // geometry changed mid-solve (a draw committed): discard, re-solve
          if (this.entityVersion !== ver) { this.solveDirty = true; continue; }
          this.conflict = r.conflicts.length > 0;
          this.conflictIdx = parseConflictIdx(r.conflicts);
          this.overIdx = parseConflictIdx(r.overDefined);
          if (!this.conflict) this.entities = r.entities; // keep last good on conflict
          this.lastDof = r.dof;
          this.refreshActive();
        }
      }
    } catch (err) {
      // Some WebView2 builds refuse to compile the solver WASM. Say so once and stop asking.
      console.error("sketch solve failed:", err);
      this.solverDead = true;
      this.lastDof = -1;
      this.conflict = false;
      if (!this.solverDeadToast) {
        this.solverDeadToast = true;
        toast(
          err instanceof SolverUnavailable
            ? err.message
            : "The 2D constraint solver stopped responding, sketching continues without constraints",
          { kind: "error", timeout: 12000 },
        );
      }
      // The dimension that was in flight when the solver died still has to
      // land, or the very first one a user types is the one that vanishes.
      this.applyDrivingDimsDirectly();
      this.refreshActive();
    } finally {
      this.solveBusy = false;
    }
    // Settled: re-arm the pre-mutation snapshot so the NEXT edit is diffed
    // against post-solve geometry. Without this, a later no-op requestSolve
    // would see the solver's own movement and bank a phantom undo step.
    if (!this.dragFrom && !this.moveDrag) this.armPreEdit();
    this.onState?.();
  }

  // --- interactive drag: grab a point, geometry follows, constraints hold ---
  /** the moved entity's attachment points: positions where neighbors may coincide */
  private attachmentPoints(e: ResolvedEntity): THREE.Vector2[] {
    if (e.type === "line" || e.type === "arc") {
      return [new THREE.Vector2(e.x1, e.y1), new THREE.Vector2(e.x2, e.y2)];
    }
    if (e.type === "rectangle") return rectCorners(e.x, e.y, e.width, e.height, e.angle).map((q) => q.clone());
    if (e.type === "spline") {
      const last = e.points.length - 1;
      const a = e.points[0], b = e.points[last];
      return a && b ? [new THREE.Vector2(a.x, a.y), new THREE.Vector2(b.x, b.y)] : [];
    }
    if (e.type === "bspline" && !e.closed) {
      const a = e.poles[0], b = e.poles[e.poles.length - 1];
      return a && b ? [new THREE.Vector2(a.x, a.y), new THREE.Vector2(b.x, b.y)] : [];
    }
    if (e.type === "circle" || e.type === "point") return [new THREE.Vector2(e.x, e.y)];
    return [];
  }

  /** Mutators for other entities' endpoints on `pts`, keyed like the solver's merge. */
  private stretchTargets(movedIdx: number, pts: THREE.Vector2[]): ((dx: number, dy: number) => void)[] {
    const keys = new Set(pts.map((q) => coincKey(q.x, q.y)));
    const near = (x: number, y: number) => keys.has(coincKey(x, y));
    const out: ((dx: number, dy: number) => void)[] = [];
    this.entities.forEach((e, i) => {
      if (i === movedIdx) return;
      if (e.type === "line" || e.type === "arc") {
        if (near(e.x1, e.y1)) out.push((dx, dy) => { e.x1 += dx; e.y1 += dy; });
        if (near(e.x2, e.y2)) out.push((dx, dy) => { e.x2 += dx; e.y2 += dy; });
      } else if (e.type === "spline" || (e.type === "bspline" && !e.closed)) {
        const pts = e.type === "spline" ? e.points : e.poles;
        const last = pts.length - 1;
        for (const k of [0, last]) {
          const q = pts[k];
          if (q && near(q.x, q.y)) out.push((dx, dy) => { q.x += dx; q.y += dy; });
        }
      } else if (e.type === "point") {
        if (near(e.x, e.y)) out.push((dx, dy) => { e.x += dx; e.y += dy; });
      }
    });
    return out;
  }

  /** Find the nearest solver-controlled point (line endpoint or circle centre)
   *  within pick tolerance of p. Rigid shapes (polygon/slot) are intentionally
   *  excluded, they don't expand to solver points. */
  private pickPoint(p: THREE.Vector2): { p: THREE.Vector2; idx: number; pole: number } | null {
    const tol = this.pickTol();
    let best: THREE.Vector2 | null = null;
    let bestIdx = -1;
    let bestPole = -1;
    let bestD = tol * tol;
    let cur = -1;
    const consider = (x: number, y: number, pole = -1) => {
      const dx = x - p.x, dy = y - p.y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = new THREE.Vector2(x, y); bestIdx = cur; bestPole = pole; }
    };
    this.entities.forEach((e, i) => {
      cur = i;
      if (e.type === "line") { consider(e.x1, e.y1); consider(e.x2, e.y2); }
      else if (e.type === "circle") consider(e.x, e.y);
      else if (e.type === "arc") { consider(e.x1, e.y1); consider(e.x2, e.y2); }
      else if (e.type === "spline") for (const q of e.points) consider(q.x, q.y);
      else if (e.type === "bspline") {
        // off-curve poles are only grabbable while their polygon is on screen
        const shown = this.selected.has(e.id);
        const last = e.poles.length - 1;
        e.poles.forEach((q, k) => { if (shown || (!e.closed && (k === 0 || k === last))) consider(q.x, q.y, k); });
      }
      else if (e.type === "point") consider(e.x, e.y);
      else if (e.type === "rectangle") {
        const hw = e.width / 2, hh = e.height / 2;
        consider(e.x - hw, e.y - hh); consider(e.x + hw, e.y - hh);
        consider(e.x + hw, e.y + hh); consider(e.x - hw, e.y + hh);
      }
    });
    return best ? { p: best, idx: bestIdx, pole: bestPole } : null;
  }

  /** Snap anchors minus the grabbed entity and anything joined to the grabbed point, which move with it. */
  private anchorsAwayFrom(idx: number, grabbed: THREE.Vector2): SnapCandidate[] {
    const at = coincKey(grabbed.x, grabbed.y);
    const still = this.entities.filter((e, i) =>
      i !== idx && !this.attachmentPoints(e).some((q) => coincKey(q.x, q.y) === at));
    return [...candidatesFromEntities(still), ...this.faceAnchorCandidates(), ...originCandidate(this.plane)];
  }

  /** The cursor on the plane, pulled onto an anchor it is near unless Ctrl is held. */
  private dragPointTarget(e: PointerEvent): THREE.Vector2 | null {
    const raw = this.planePoint(e);
    const res = raw && !e.ctrlKey
      ? dragSnap(raw, this.dragAnchors, (q) => this.viewport.projectToScreen(this.plane.to3D(q.x, q.y)))
      : null;
    this.showSnap(res ? { kind: res.kind, p: res.point, world: this.plane.to3D(res.point.x, res.point.y), label: res.label, guides: res.guides } : null);
    return res?.point ?? raw;
  }

  /** Queue a drag target; pump serializes solves (the latest target is used). */
  private queueDrag(to: THREE.Vector2) {
    if (!this.dragFrom) return;
    this.pendingDrag = { fromX: this.dragFrom.x, fromY: this.dragFrom.y, toX: to.x, toY: to.y };
    void this.pump();
  }

  private endDrag(pointerId?: number) {
    if (this.patternFlow.releaseCentre()) {
      if (pointerId != null) {
        try { this.viewport.domElement.releasePointerCapture(pointerId); } catch { /* not captured */ }
      }
      return;
    }
    if (this.boxDown) {
      const b = this.boxDown;
      const boxed = this.areaBox.visible;
      this.cancelBox();
      if (pointerId != null) {
        try { this.viewport.domElement.releasePointerCapture(pointerId); } catch { /* not captured */ }
      }
      if (boxed) {
        if (!b.additive) this.overlay.clearRegionSelection();
        this.onState?.();
        return;
      }
      if (b.region) {
        // A plain click on a profile with nothing else picked is the sketch, click,
        // pull loop: finish and leave the profile selected, so the model view
        // offers its extrude handle on it. With curves picked the click only
        // swaps to the profile, so clicking inside a shape to drop a selection
        // does not throw you out of the sketch.
        if (!b.additive && this.selected.size === 0) {
          this.overlay.clearRegionSelection();
          this.overlay.toggleRegionSelection(b.region, false);
          this.finish(true);
          return;
        }
        if (!b.additive && this.selected.size) { this.selected.clear(); this.refreshActive(); }
        this.overlay.toggleRegionSelection(b.region, b.additive);
        return;
      }
      if (!b.shift) {
        this.selected.clear();
        this.overlay.clearRegionSelection();
      }
      this.refreshActive();
      return;
    }
    if (this.textBoxStart) {
      // finish a text placement: a real drag = a box (wrap width); a click = point anchor
      const s = this.textBoxStart, screen = this.textBoxScreen ?? { x: 0, y: 0 }, end = this.textBoxEnd;
      this.textBoxStart = null;
      this.textBoxEnd = null;
      this.textBoxScreen = null;
      if (pointerId != null) {
        try { this.viewport.domElement.releasePointerCapture(pointerId); } catch { /* not captured */ }
      }
      this.overlay.setPreview([]);
      const phi = this.viewRightAngle();
      if (end) {
        const dx = end.x - s.x, dy = end.y - s.y;
        const cos = Math.cos(phi), sin = Math.sin(phi);
        const wView = Math.abs(dx * cos + dy * sin); // box extent along screen-right (wrap width)
        const hView = Math.abs(-dx * sin + dy * cos); // box extent along screen-up
        if (wView > 1 && hView > 1) {
          const cx = (s.x + end.x) / 2, cy = (s.y + end.y) / 2;
          this.openTextPanel(new THREE.Vector2(cx, cy), screen, { x: cx, y: cy, width: wView }, undefined, phi);
          return;
        }
      }
      this.openTextPanel(s, screen, undefined, undefined, phi);
      return;
    }
    if (this.moveDrag) {
      const md = this.moveDrag;
      this.moveDrag = null;
      if (pointerId != null) {
        try { this.viewport.domElement.releasePointerCapture(pointerId); } catch { /* not captured */ }
      }
      const ent = this.entities[md.idx];
      if (!md.started) {
        // never moved: this was a click, the original (de)select behavior
        this.dragSnapshot = null;
        if (ent?.type === "text") {
          if (md.region) this.overlay.toggleRegionSelection(md.region, md.shift);
          else if (!md.shift) this.overlay.clearRegionSelection();
          return;
        }
        if (ent) {
          if (md.shift) {
            if (!this.selected.delete(ent.id)) this.selected.add(ent.id);
          } else {
            this.selected = new Set([ent.id]);
          }
          this.refreshActive();
        }
        return;
      }
      this.bankDrag(); // the whole move is ONE undo step, not one per frame
      this.refreshActive();
      this.requestSolve(); // re-satisfy constraints at the new position
      this.onState?.(); // undo checkpoint
      return;
    }
    if (!this.dragFrom) return;
    this.dragFrom = null;
    this.pendingDrag = null;
    this.dragAnchors = [];
    this.showSnap(null);
    if (pointerId != null) {
      try { this.viewport.domElement.releasePointerCapture(pointerId); } catch { /* not captured */ }
    }
    if (!this.dragMoved) {
      // never moved: a click on a vertex, (de)select the owning entity, same
      // behavior as clicking its body (users click near endpoints constantly;
      // this used to silently do nothing)
      this.dragSnapshot = null;
      const ent = this.entities[this.dragEntIdx];
      this.dragEntIdx = -1;
      if (ent) {
        if (this.dragShift) {
          if (!this.selected.delete(ent.id)) this.selected.add(ent.id);
        } else {
          this.selected = new Set([ent.id]);
        }
      }
      this.selectedPole = ent?.type === "bspline" && this.dragPole >= 0 && this.selected.has(ent.id) ? { id: ent.id, k: this.dragPole } : null;
      this.refreshActive();
      return;
    }
    this.dragEntIdx = -1;
    this.bankDrag(); // the whole drag is ONE undo step, not one per frame
    this.refreshActive(); // restore snap candidates + dimension labels at final positions
    this.onState?.();
  }

  /** remaining degrees of freedom (>0 under-constrained, 0 fully constrained) */
  get dof(): number {
    return this.lastDof;
  }

  /** preview while drawing an arc: chord after 1st click, arc after 2nd */
  private arcPreview(cursor: THREE.Vector2) {
    if (this.arcStart && !this.arcEnd) {
      const a = this.arcStart;
      this.overlay.setPreview([
        this.entityCurve({ type: "line", id: "", x1: a.x, y1: a.y, x2: cursor.x, y2: cursor.y }),
      ]);
    } else if (this.arcStart && this.arcEnd) {
      const a = this.arcStart;
      const b = this.arcEnd;
      this.overlay.setPreview([
        this.entityCurve({ type: "arc", id: "", x1: a.x, y1: a.y, x2: b.x, y2: b.y, mx: cursor.x, my: cursor.y }),
      ]);
    } else {
      this.overlay.setPreview([]);
    }
  }

  // --- grid --------------------------------------------------------------
  private addGrid() {
    this.removeGrid();
    const grid = new SketchPlaneGrid();
    grid.setVisible(this.gridVisible);
    this.grid = grid;
    this.viewport.addToScene(grid.object);
    this.updateGrid(); // build it now rather than showing an empty frame
  }
  private removeGrid() {
    if (this.grid) {
      this.viewport.removeFromScene(this.grid.object);
      this.grid.dispose();
      this.grid = null;
    }
  }
}
