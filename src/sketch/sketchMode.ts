// The modal sketch environment: enter on a plane (camera squares to it, model
// dims, grid appears), draw Line/Rectangle/Circle interactively with snapping
// and on-canvas dimension input, then Finish to commit the sketch feature.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { EdgeFingerprint, Feature, ParamTarget, PlaneSpec, ProjectedSource, ProjectionUpdate, Selector, SketchConstraint, SketchPattern } from "../types";
import { applyProjectionUpdate, dimPlaceOf, isBadgeEntity, isPlacedDim } from "../types";
import { SketchPlane } from "./plane";
import { SketchOverlay, curveObjects, dimensionLineObjects, CURVE_COLOR, PREVIEW_COLOR, SELECT_COLOR } from "./overlay";
import { DimInput } from "./dimInput";
import { TextPanel } from "./textPanel";
import type { TextValues } from "./textPanel";
import { fetchFonts } from "./textCache";
import { isEditableTarget } from "../ui/focus";
import { SketchDimensions, type ExtraDim } from "./sketchDimensions";
import { SketchGlyphs } from "./sketchGlyphs";
import { RelationsPanel } from "./relationsPanel";
import { constraintGlyphs, diagnosisOf } from "./glyphs";
import { entityDims, constraintDims, dimRefPoints, curveKind, setDimPixelScale, staggeredDefaults, type DimField, type ConstraintDim } from "./entityDims";
import { clampPlace, pickDimTarget } from "./dimensionTool";
import { pickEntity, trimEntity, filletCorner, chamferCorner, offsetEntity, offsetChain, signedOffsetAt, breakAt, extendLine, breakLink, PROJECTED_FIXED_MSG, type OffsetResult } from "./modify";
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
import { expandPattern, translated, rotated, scaled } from "./pattern";
import { candidatesFromEntities, showsSnapMarker, snap, type SnapGuide, type SnapKind, type SnapCandidate } from "./snap";
import type { ResolvedEntity } from "./snap";
import { detectRegions, rectCorners, rectFromThreePoints } from "./region";
import { loopsFromEdgePolys, planeEdgePolys } from "./faceFootprint";
import { boundaryAnchors, footprintAnchors } from "./anchors";
import { setSpaceMouseOrbitLocked } from "../input/spacemouse";
import { setPrompt } from "../ui/prompt";
import { tooEdgeOn } from "./planeGraze";
import { toast } from "../ui/toast";
import { contextMenu, dismissContextMenu, type CtxItem } from "../ui/menu";
import { ConstraintTools, CONSTRAINT_TOOLS, type ConstraintHost } from "./constraintTools";
import { PatternFlow, PATTERN_TOOLS, ENTITY_PATTERNS, type PatternHost } from "./patternFlow";
import { DimFlow, type DimHost } from "./dimFlow";
import { ProjectPanel } from "./projectPanel";
import { sketchEscapeAction } from "./escapeLayers";
import { gridReach, gridStep, SketchPlaneGrid, snapLatticeStep } from "./planeGrid";
import { INFER_TOL_DEG, inferLineDirection } from "./inferLine";
import { sketchLockHolds, viewSquareToPlane } from "./sketchView";

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
const KEEPS_SELECTION = new Set<SketchTool>(["mirror", "move", "copy", "rotate", "scale"]);

// Tolerant edge-fingerprint compare for the Project tool's duplicate-pick check.
// Fingerprints carry unrounded float noise (sidecar-authored), so byte equality
// is meaningless — same midpoint (within 1e-3 mm), same unoriented tangent, and
// a matching length when both carry one, is "the same edge".
function fpClose(a: EdgeFingerprint, b: EdgeFingerprint): boolean {
  if (Math.hypot(a.mid[0] - b.mid[0], a.mid[1] - b.mid[1], a.mid[2] - b.mid[2]) > 1e-3) return false;
  const dot = Math.abs(a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2]);
  if (dot < 1 - 1e-6) return false;
  if (a.length != null && b.length != null && Math.abs(a.length - b.length) > 1e-3) return false;
  return true;
}

// Sentinel id for the in-progress text tool's live-preview entity: it lives on the
// active entity list (so it repaints through the normal render path) but is never
// committed — filtered out at serialization and dropped on tool switch/cancel.
const TEXT_PREVIEW_ID = "__textpreview__";

// The cross marking a face anchor (the centre of the face, and of each hole in
// it). A dimmed cousin of the sketch curve blue: near enough to read as "a thing
// you can snap to", far enough from CURVE_COLOR that it is never mistaken for
// geometry that has been drawn.
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

  private plane = new SketchPlane("XY");

  /** The model's outline on this sketch's plane, in sketch 2D — what makes a

   *  profile that runs off the face split there. Empty on a datum plane. */

  private footprint: THREE.Vector2[][] = [];
  /** The same edges, UN-chained — one polyline each, which is what tells a
   *  corner from a point part way along an arc. See anchors.boundaryAnchors. */
  private footprintEdges: THREE.Vector2[][] = [];
  private entities: ResolvedEntity[] = [];
  private candidates: SnapCandidate[] = []; // cached; rebuilt when entities change
  private base: THREE.Vector2 | null = null; // pending first point
  private chainStart: THREE.Vector2 | null = null; // first point of a line chain
  private arcStart: THREE.Vector2 | null = null; // 3-point arc: start, end, then bulge
  private arcEnd: THREE.Vector2 | null = null;
  private splinePts: THREE.Vector2[] = []; // in-progress spline fit points
  private clickPts: THREE.Vector2[] = []; // accumulated clicks for multi-point primitives (polygon/slot/circle variants)
  private polygonSides = 6; // n for the polygon tool
  private filletFirst: number | null = null; // first line picked for a sketch fillet
  private selected = new Set<string>(); // selected entity ids (select tool)
  /** The Relations list in the Sketch Palette. */
  private relations = new RelationsPanel();
  /** Entity ids lit by the relations row under the cursor. Display only: it
   *  never reaches the document, the solver or the undo history. */
  private relHover = new Set<string>();
  private constraints: SketchConstraint[] = []; // persistent constraints (solved)
  private patterns: SketchPattern[] = []; // associative pattern definitions
  private lastDof = -1;
  private dragFrom: THREE.Vector2 | null = null; // grabbed point's current position
  // click-vs-drag bookkeeping for a grabbed POINT: which entity owns it, where
  // the pointer went down (screen px), and whether it ever moved past the same
  // 4px threshold moveDrag uses. A stationary click on a vertex must still
  // SELECT the owning entity instead of silently doing nothing.
  private dragEntIdx = -1;
  private dragStartClient = { x: 0, y: 0 };
  private dragMoved = false;
  private dragShift = false;
  private dragSnapshot: ResolvedEntity[] | null = null; // entities at drag start (Esc reverts)

  // --- in-sketch undo -------------------------------------------------------
  // Ctrl+Z used to reach store.undo(), which pops whole-DOCUMENT snapshots — and
  // an open sketch isn't in the document until finish(), so the newest entry IS
  // the sketch. Ten lines drawn, one Ctrl+Z, all ten gone. These stacks live for
  // the editing session only; leaving and re-entering a sketch starts fresh.
  private history = new SketchHistory();
  private dragRefusedToast = false; // one fixed-point toast per refused drag gesture
  private pendingDrag: { fromX: number; fromY: number; toX: number; toY: number } | null = null;
  // whole-entity body drag (select tool, no grab point under the cursor):
  // armed cheaply on pointerdown over an entity body; the snapshot and the
  // neighbor-stretch closures are built only when the move actually starts
  // (past a small screen-space threshold) — a plain click stays free and
  // falls through to selection on up.
  private moveDrag: {
    idx: number;
    startClient: { x: number; y: number };
    last: THREE.Vector2;
    started: boolean;
    shift: boolean;
    stretch: ((dx: number, dy: number) => void)[]; // filled when the move starts
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
  private moveBase: THREE.Vector2 | null = null;
  // distance-constraint dims, computed once per refreshActive() in activeCurves()
  // and reused for the clickable labels (constraintDimExtras)
  private cdims: ConstraintDim[] = [];
  private editingId: string | null = null;
  /** The datumPlane feature this sketch is placed ON, when it was created from
   *  one. Round-tripped through finish() so re-editing a sketch never silently
   *  downgrades it from a live datum link to a baked placement. */
  private planeId: string | null = null;
  private store: DocumentStore | undefined;
  private grid: SketchPlaneGrid | null = null;
  /** Where the grid's fade is centred, in sketch mm — the cursor, so the lattice
   *  is densest under the point you are about to place, and the sketch origin
   *  before the pointer has moved. */
  /** Scratch for the lattice centre and the camera target it comes from, so the
   *  per-frame grid update allocates nothing. Written by updateGrid(); read by
   *  nobody else. */
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
  // Glyph cIndex and conflictIdx are POSITIONAL into this.constraints. The handle
  // stays valid because every this.constraints mutation is followed by
  // refreshActive(), which re-show()s glyphs with fresh indices before the next
  // input frame — so a click can't carry a stale index. (No per-constraint UID.)
  private conflictIdx = new Set<number>(); // constraint indices the solver flagged conflicting
  private overIdx = new Set<number>(); // indices flagged redundant / over-defining (removable)
  private readonly textPanel = new TextPanel();
  // Project tool: filter chips (edges&faces / sketch curves) + a one-at-a-time
  // in-flight gate so a double-click can't race two projectGeometry calls.
  private readonly projectPanel = new ProjectPanel();
  private projectBusy = false;
  private fonts: string[] = []; // system fonts for the text tool (loaded on enter)
  // text tool: press-drag defines a box (wrap width); a plain click is a point anchor.
  private textBoxStart: THREE.Vector2 | null = null;
  private textBoxEnd: THREE.Vector2 | null = null;
  private textBoxScreen: { x: number; y: number } | null = null;
  private viewLocked = false; // the palette's "Lock to Plane" preference (off by default)
  // --- the sketch view's soft lock -------------------------------------------
  // "Lock to Plane" used to mean a hard lock for the whole session: squared to
  // the plane, orthographic, orbit disabled, full stop. That is right while you
  // are drawing and wrong the moment you pull back to see where the sketch sits
  // on the part — which is exactly what you do on a face at an awkward angle,
  // where a flat straight-on projection shows you a silhouette with no depth to
  // read. So the lock now measures itself against the framing the sketch opened
  // at (see sketchView.sketchLockHolds) and lets go once you have zoomed out
  // past it. Placement is unaffected either way: every point is raycast onto the
  // sketch plane, so it works at any view angle.
  /** view half-height when the sketch settled, the baseline the release is
   *  measured against. Null until the camera has actually got there. */
  private entryScale: number | null = null;
  private lockReleased = false;
  private releaseAnnounced = false; // say it once per session, not once per frame
  private raf = 0;
  private dim: DimInput;
  private dims: SketchDimensions;
  private glyphs: SketchGlyphs;
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
      // so beats a right-click that appears to do nothing.
      contextMenu(e.clientX, e.clientY, [
        { label: "Delete dimension", danger: true, disabled: !del, shortcut: "Del", onClick: () => del?.() },
      ]);
    };
    this.glyphs = new SketchGlyphs(viewport);
    this.glyphs.onDelete = (i) => this.deleteConstraint(i);
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
      getFilletFirst: () => this.filletFirst,
      setFilletFirst: (v) => { this.filletFirst = v; },
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
    // Filter chip clicks land on the panel, not the canvas, so projectHover
    // doesn't run — clear the other mode's hover feedback explicitly.
    this.projectPanel.onChange = () => {
      this.viewport.hoverEntity(null);
      this.overlay.setPreview([]);
      this.viewport.requestRender();
    };
  }

  // --- lifecycle ---------------------------------------------------------
  /** `planeId` links the sketch to a datumPlane FEATURE instead of freezing its
   *  placement: `plane` is still stored (as the resolved cache every frontend
   *  consumer reads), but the sidecar prefers the id, so editing the datum's
   *  offset later moves this sketch. Without it an offset plane's distance is
   *  baked into the origin and gone. */
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
    // The face this sketch is drawn on, so the sidecar can re-derive the plane
    // every rebuild instead of the sketch recording where the face used to be.
    // A sketch on a base plane or on a datum has none, and neither needs one.
    this.face = face ?? null;
    this.store = store;
    // Once per session, not per edit. The plane is fixed for the whole sketch
    // and the body under it cannot change while the sketch is open — nothing is
    // applied to the model until commit — so re-deriving this on every keystroke
    // would walk every edge of the body for an answer that cannot have moved.
    // One walk of the model's edges, two results: the chained loops the region
    // detector needs, and the edges themselves, which is where the corner and
    // side anchors come from.
    this.footprintEdges = planeEdgePolys(
      this.viewport.visibleEdgeLines(),
      this.plane,
      this.viewport.modelDiagonal() ?? 0,
    );
    this.footprint = loopsFromEdgePolys(this.footprintEdges);
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
      if (f && f.type === "sketch") {
        // real entities only — derived pattern copies are NEVER stored in
        // this.entities (see derivedEntities()); doing so would persist them
        // as real geometry on the next finish() and bake in duplicates (§1.2).
        this.entities = resolveRealEntities(f, store.document.parameters);
        this.constraints = f.constraints ? f.constraints.map((c) => ({ ...c })) : [];
        this.patterns = f.patterns ? f.patterns.map((p) => ({ ...p })) : [];
        // keep an existing datum link across a re-edit (the caller only passes
        // planeId when it just created the datum)
        if (f.planeId) this.planeId = f.planeId;
        // ...and the same for the face anchor: re-editing a sketch must not
        // strip the reference that makes it follow. The caller passes one only
        // when the sketch is being CREATED on a face.
        if (f.face) {
          this.face = { selector: f.face, at: (f.at ?? [0, 0, 0]) as [number, number, number] };
        }
        for (const p of this.patterns) notePatternId(p.id); // reserve ids so new ones don't collide
      }
    }

    this.viewport.suspendPicking = true;
    this.viewport.enterSketchView(this.plane.origin, this.plane.n, this.plane.v);
    this.entryScale = null; // re-baselined on the first tick, once the camera lands
    this.lockReleased = false;
    this.releaseAnnounced = false;
    this.gridFocus.set(0, 0); // scratch; updateGrid() writes the camera target into it
    this.addGrid();
    if (!this.raf) this.raf = requestAnimationFrame(this.boundTick);

    const el = this.viewport.domElement;
    el.addEventListener("pointerdown", this.boundDown);
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerup", this.boundUp);
    el.addEventListener("contextmenu", this.boundContext);
    el.addEventListener("pointerleave", this.boundLeave);
    window.addEventListener("keydown", this.boundKey, true);

    this.overlay.update(store.document, this.editingId ?? "__active__");
    this.refreshActive();
    this.armPreEdit(); // the session's baseline: the first edit undoes back to here
    this.setTool("rectangle");
    this.setViewLocked(this.viewLocked); // apply lock-to-plane preference
    if (this.constraints.length > 0) this.requestSolve(); // restore DOF state
    this.onState?.();
  }

  /** The feature this session WOULD commit, built without committing it.
   *
   *  An open sketch lives entirely in this class — `entities`, `constraints` and
   *  `patterns` are a working copy, and nothing reaches the store until finish()
   *  runs. So anything that serialises the document mid-session sees a sketch
   *  that is stale (when editing) or absent altogether (when new). That is why a
   *  bug filed from inside the sketcher used to arrive with an empty document,
   *  which cost a repro on the 2026-08-02 dimension report; the bug reporter now
   *  splices this in. Shared with finish() so the two can never disagree.
   *
   *  Null when no sketch is open, or when nothing has been drawn yet. */
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

  finish(commit = true) {
    if (!this.active) return;
    const store = this.store!;
    this.patternFlow.flushOnFinish(); // may add patterns — must precede the snapshot
    const sketch = commit ? this.snapshotFeature() : null;
    if (sketch) {
      if (this.editingId) {
        store.replaceFeature(this.editingId, sketch, this.drainBindings(sketch.id));
      } else {
        store.addFeature(sketch, undefined, this.drainBindings(sketch.id));
      }
    }
    this.cleanup();
  }

  cancel() {
    this.cleanup();
  }

  private cleanup() {
    const el = this.viewport.domElement;
    this.pendingBindings.clear();
    el.removeEventListener("pointerdown", this.boundDown);
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerup", this.boundUp);
    el.removeEventListener("contextmenu", this.boundContext);
    el.removeEventListener("pointerleave", this.boundLeave);
    window.removeEventListener("keydown", this.boundKey, true);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    dismissContextMenu();
    this.selected.clear();
    this.dragFrom = null;
    this.dragSnapshot = null;
    this.pendingDrag = null;
    this.moveDrag = null;
    this.dim.hide();
    this.dims.hide();
    this.glyphs.hide();
    this.relations.hide();
    this.relHover.clear();
    this.textPanel.hide();
    this.projectPanel.hide();
    // The prompt is a transient like the rest of these, and was the one thing
    // cleanup() forgot: leaving the sketch used to leave "Rectangle: click two
    // corners · type W, Tab, H · Enter · Esc" on screen while the context tab
    // had already switched back to SOLID, telling the user to do something the
    // app was no longer listening for. Whichever tool comes next sets its own.
    setPrompt(null);
    this.viewport.hoverEntity(null); // drop any Project-tool 3D hover highlight
    this.overlay.setPreview([]);
    this.overlay.setSnap(null);
    this.snapWorld = null;
    this.removeGrid();
    this.viewport.exitSketchView();
    this.viewport.rig.setOrbitLocked(false); // restore free orbit in model mode
    setSpaceMouseOrbitLocked(false);
    this.viewport.suspendPicking = false;
    this.active = false;
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
    // Mirror operates on the current multi-selection, so keep it; every other
    // tool starts from a clean slate.
    // Mirror + the transform tools (move/copy/rotate/scale) operate on the
    // current multi-selection, so keep it; every other tool starts clean.
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
    this.filletFirst = null;
    this.dragFrom = null;
    this.pendingDrag = null;
    this.moveDrag = null;
    this.dimFlow.resetDimPicks();
    this.moveBase = null;
    this.offsetPick = null; // an in-progress offset dies with its tool
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
    // Labels and glyphs take clicks in `select` and, since 2026-08-03, in
    // `dimension`. Two field reports (0.1.76 and 0.1.77) said dimensions could
    // not be edited or deleted "after the fact": the dimension tool re-arms
    // after every commit (it is a batch activity, see dimensionClick), so a user
    // who had just dimensioned a sketch was still in that tool, where every
    // label and glyph was pointer-transparent with no cursor change to say so.
    // labelOverlapDimension keeps dimensioning's own clicks working.
    const annotationsLive = t === "select" || t === "dimension";
    this.dims.setInteractive(annotationsLive);
    this.glyphs.setInteractive(annotationsLive);
    this.onState?.();
  }

  /** Public re-draw hook: e.g. async glyph outlines for a text entity just arrived,
   *  so the active sketch's curves (incl. text + its live preview entity) need
   *  repainting. No-op when inactive. */
  redraw(): void {
    if (this.active) this.refreshActive();
  }

  /** Rebuild the active sketch's committed curves + snap candidates + editable
   * dimension labels. Called when the entity list changes — and on drag end. */
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
        // Empty means "no model in this plane" — a datum-plane sketch — and must
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
    ];
    // an in-progress dimension holds entity REFERENCES, and a solve replaces
    // every entity object — re-read the picks off the fresh list
    if (this.dimFlow.picking) this.dimFlow.refreshDimPlan();
    if (this.dimsVisible) this.dims.show(this.entities, this.plane, this.constraintDimExtras());
    else this.dims.hide();
    if (this.glyphsVisible) this.glyphs.show(constraintGlyphs(this.entities, this.constraints), this.plane, this.conflictIdx, this.overIdx);
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

  /** Lightweight per-frame refresh for dragging: only the curve geometry moves,
   * so skip the snap-candidate array (snapping is off mid-drag) and the
   * dimension-label DOM teardown/rebuild. refreshActive() restores both on end. */
  private refreshDragGeometry() {
    this.entityVersion++;
    this.overlay.setActiveSketch(curveObjects(this.entities, this.plane, this.activeColor()));
  }

  // --- per-frame reconcile (grid + view lock) --------------------------------
  /** One loop for the two things that follow the CAMERA rather than the
   *  document, neither of which has an event to hang off: the grid's spacing and
   *  extent, and how far the view has drifted from the plane it opened on. Zoom
   *  arrives from the wheel, the SpaceMouse, a fit and the ViewCube, so watching
   *  the camera once a frame is both simpler and more complete than subscribing
   *  to four input paths — the same argument SelectionNudge makes for its tick.
   *  Cheap by construction: the grid rebuild is key-guarded and the release
   *  check is one comparison. */
  private tick() {
    this.raf = requestAnimationFrame(this.boundTick);
    if (!this.active) return;
    const scale = this.viewport.rig.viewScale();
    if (this.entryScale == null) {
      // First frames of the session. The entry flight is still in the air, and
      // mid-flight the camera is nowhere in particular — baselining off it would
      // measure the view we came FROM (or a point on the way), and every later
      // "have we drifted?" comparison would be against that.
      if (this.viewport.rig.isFlying()) return;
      this.entryScale = scale;
      return;
    }
    this.updateGrid();
    this.updateAnnotationScale();
    this.updateSnapScale();
    if (this.lockReleased) return;
    // Two ways to stop being square to the plane, one per mode. LOCKED: you
    // cannot orbit, so the only way out is to zoom back far enough that you are
    // plainly looking at the part rather than at what you are drawing. UNLOCKED:
    // you can just turn, and the flat projection has to go with you or the model
    // behind the sketch stays a depthless silhouette.
    const drifted = this.viewLocked
      ? !sketchLockHolds(this.entryScale, scale)
      : !viewSquareToPlane(this.viewDir(), this.plane.n.toArray() as [number, number, number]);
    if (drifted) this.releaseView();
  }

  /** Which way the camera is pointing, as a plain tuple for sketchView. */
  private viewDir(): [number, number, number] {
    const c = this.viewport.rig.controls;
    const eye = c.getPosition(new THREE.Vector3());
    const at = c.getTarget(new THREE.Vector3());
    return [at.x - eye.x, at.y - eye.y, at.z - eye.z];
  }

  /** The view has pulled back far enough that holding it square to the plane is
   *  costing more than it buys: hand the camera back. Orbit is re-enabled and
   *  the projection returns to whatever it was before the sketch forced flat,
   *  so the part regains its depth and a face at an odd angle can be looked at
   *  from an angle that suits it. The sketch itself does not change — the plane,
   *  the snapping and every placement still go through the plane raycast. */
  private releaseView() {
    const wasLocked = this.viewLocked;
    this.lockReleased = true;
    this.viewport.rig.setOrbitLocked(false);
    setSpaceMouseOrbitLocked(false);
    this.viewport.setSketchFlat(false);
    // Only ANNOUNCE a release when something was actually holding the view. With
    // the lock off — the default — turning away is the ordinary thing to do and
    // being told about it every time would be noise.
    if (!wasLocked || this.releaseAnnounced) return;
    this.releaseAnnounced = true;
    toast("View unlocked. Drawing still lands on the sketch plane; Look At re-squares it.");
  }

  /** Re-arm the lock and re-baseline it. Called by anything that deliberately
   *  puts the camera back on the plane, so a released session can be recovered
   *  without leaving and re-entering the sketch. */
  private squareToPlane() {
    this.viewport.enterSketchView(this.plane.origin, this.plane.n, this.plane.v);
    this.lockReleased = false;
    this.entryScale = null; // re-measured on the next tick, from the new framing
  }

  /** A dimension's FURNITURE — arrowhead length, stand-off, label clearance — is
   *  a screen quantity built into world-space geometry (see entityDims.px), so
   *  the mm-per-pixel it was built at has to be the CURRENT one.
   *
   *  It was set once per refreshActive(), i.e. only when the entity list
   *  changed. Zoom or pan after that and the annotations kept the size they were
   *  drawn at: a sketch entered close and then pulled back grew arrowheads that
   *  read as gigantic against the geometry they belonged to, and one entered far
   *  out and zoomed into lost its arrowheads entirely. Neither corrected itself
   *  until the next edit.
   *
   *  Rebuilt on a 5% change rather than every frame: 5% of an arrowhead is a
   *  third of a pixel, so nothing visibly lags, and a continuous wheel-zoom
   *  costs about one rebuild per notch instead of one per frame. */
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

  /** Millimetres to a screen pixel WHERE THE USER IS LOOKING: the camera target
   *  dropped onto the sketch plane.
   *
   *  Everything the sketch draws for the EYE rather than for the model — the
   *  grid's spacing, an arrowhead, a dimension's stand-off, the snap marker —
   *  is a pixel quantity baked into world geometry, and so needs a mm-per-pixel
   *  to bake it at. That figure used to be taken at the plane's ORIGIN.
   *
   *  Under an orthographic camera the origin is as good as anywhere, because
   *  mm-per-pixel is then the same number everywhere in the scene. And while a
   *  sketch is square to the screen the camera IS orthographic, which is why
   *  this never showed up: orbit out of the plane and the rig turns perspective
   *  ("Perspective with Ortho Faces", cameras.ts), where mm-per-pixel is a
   *  question about a POINT and the answer falls off with distance. A thread
   *  profile drawn 20mm out from the origin of the plane it sits on, and then
   *  zoomed into and turned, was having its furniture sized for a point 20mm
   *  behind it — measured at better than 2x wrong on a mild orbit, and worse
   *  the closer you get, which is the state you are in when you are looking at
   *  a 5mm triangle.
   *
   *  The model's own ground grid already measures at the camera target
   *  (viewport.ts); this is the sketch saying the same thing. In orthographic
   *  it is a strict no-op, because pixelWorldSize ignores the point it is
   *  given. */
  private planeMmPerPx(): number {
    const at = this.plane.to2D(this.viewport.cameraTarget(this.scaleAt), this.scaleAt2);
    const mm = this.viewport.pixelWorldSize(this.plane.to3D(at.x, at.y, this.scaleAt));
    // A camera target behind the eye, or a degenerate frustum, would poison
    // every size on screen. The origin is the fallback it used to be.
    return mm > 0 && Number.isFinite(mm) ? mm : this.viewport.pixelWorldSize(this.plane.origin);
  }

  private updateGrid() {
    const mmPerPx = this.planeMmPerPx();
    // The DRAWN spacing, and reported whether or not it is actually painted: the
    // readout names the grid, so it has to say what a square of it is worth, and
    // it is worth that with the grid switched off too. Not snapLatticeStep,
    // which is the same number until it hits MIN_SNAP_STEP and then stops — past
    // that the cursor is coarser than the lines, and reporting the cursor's
    // figure would put a number on screen that no square on it measures.
    this.viewport.reportGridStep(gridStep(mmPerPx, 0));
    const grid = this.grid;
    if (!grid || !this.gridVisible) return;
    // The lattice is built around what the camera is LOOKING AT, dropped onto
    // the sketch plane. It used to be built around the sketch origin, which is
    // where a fading disc has to sit if it is only nine cells wide; the grid now
    // reaches past the viewport in every direction, so it has to follow the pan
    // or you would draw your way off the end of it.
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
  /** place a dimension, stamping it driven (reference, measured-only) when the
   *  Reference palette toggle is on — or when the plan says every operand is
   *  fixed reference geometry, where a driving dim could never be satisfied.
   *  Only the 4 placed dims carry `driven` (see types.ts): a line's length and a
   *  circle's diameter always show their own measurement badge, so Reference
   *  can't apply to them — say so rather than dropping the flag in silence.
   *  Returns the constraint that was placed (carrying the id it was born with,
   *  or inherited), so a caller can bind an expression to it. */
  private placeDim(c: SketchConstraint, forceDriven = false): SketchConstraint {
    const drivenable = isPlacedDim(c);
    const driven = drivenable && (this.referenceMode || forceDriven);
    if (this.referenceMode && !drivenable) {
      toast("Lengths and diameters can't be reference dimensions yet, made this one driving");
    }
    // The forced case, said out loud. With Reference Dim OFF the user has asked
    // for a driving dimension and is getting a reference one, and until now that
    // happened in silence, which reads as the toggle being ignored. It is not:
    // both operands are projected geometry, which is fixed, so there is nothing
    // a driving value could move and the solver would only report the sketch as
    // over-constrained. The pick-time hint says so too, but that scrolls past
    // while the eye is on the geometry.
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

  /** Light the geometry a relations row names. There is no other way to tell
   *  WHICH two lines "Line 1 and Line 3" means without counting them.
   *
   *  Rebuilds the curves only, deliberately: refreshActive() would bump
   *  entityVersion and cancel any in-flight solve, and re-derive regions, snap
   *  candidates and every dimension label, none of which a hover changes. */
  private setRelationHover(ids: string[] | null) {
    const next = new Set(ids ?? []);
    if (next.size === this.relHover.size && [...next].every((id) => this.relHover.has(id))) return;
    this.relHover = next;
    this.overlay.setActiveSketch(this.activeCurves(this.derivedEntities()));
    this.viewport.requestRender();
  }

  /** Clicking a relations row selects what it acts on. Arming select first is
   *  the point rather than a side effect: the click is an inspection, and a
   *  selection made under a drawing tool is thrown away by that tool's next
   *  click. Order matters, because setTool clears the selection. */
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
    setSpaceMouseOrbitLocked(on);
  }
  /** re-square the camera to the active sketch plane (palette "Look At").
   *  This is the recovery the release toast points at, so it re-arms the lock
   *  rather than only moving the camera. */
  lookAt() {
    this.squareToPlane();
    if (this.viewLocked) {
      this.viewport.rig.setOrbitLocked(true);
      setSpaceMouseOrbitLocked(true);
    }
    // The flat projection comes back either way, and it comes back when the
    // flight LANDS (enterSketchView's onArrive) rather than now — forcing ortho
    // while the camera is still travelling runs the whole trip through a
    // parallel projection and throws away the dolly.
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

  /** Write the driving length/⌀ dimensions straight into the geometry, for when
   *  there is no solver to do it properly.
   *
   *  These two dimensions are the only ones that go through a constraint rather
   *  than editing coordinates (see editDimension), so on a machine where the
   *  solver's WASM will not start they were the only ones that silently did
   *  NOTHING: the constraint was recorded, never solved, and the circle stayed
   *  the size it was drawn. Rectangle W/H kept working, which is exactly how a
   *  Windows user reported it — "when creating a circle I am unable to put in a
   *  new value for the dimension, other shapes seem to work fine" (0.1.100).
   *
   *  The constraint is deliberately KEPT. This is a best-effort stand-in, not a
   *  replacement: the moment a real solver is available it drives the geometry
   *  properly, and nothing about the saved sketch is different from one authored
   *  on a working machine.
   *
   *  Only the unambiguous single-entity cases are handled. Anything relating two
   *  entities needs a solve to decide WHICH of them moves, and guessing would
   *  put geometry somewhere the user did not ask for. */
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
  // A dragged label writes its offset where that dimension's placement LIVES:
  // on the constraint for the placed dims, on the entity (`dimPlace`) for the
  // badges, which have no backing constraint. See types.ts. Placement is
  // annotation only — it never changes geometry, so neither path re-solves.

  /** Re-lay-out after a placement write and hand back the dim's new label
   *  anchor. Mid-drag stays on the cheap path — curves + dimension lines only —
   *  because a full refreshActive() would tear down the very label element the
   *  drag is riding on. */
  private afterPlaceDrag(done: boolean, anchor: () => THREE.Vector2 | null): THREE.Vector2 | null {
    if (done) {
      this.refreshActive();
      this.onState?.(); // undo checkpoint: the placement is a document edit
      return null; // labels were just rebuilt — the caller's is gone
    }
    this.overlay.setActiveSketch(this.activeCurves(this.derivedEntities())); // also refreshes this.cdims
    this.viewport.requestRender();
    return anchor();
  }

  /** Persist a dragged ENTITY badge placement (rect W/H, circle diameter,
   *  polygon radius, slot L/W, line length). A drag back onto the geometry
   *  (clampPlace's null: inside the same screen-space floor the badge's own
   *  clearance uses) CLEARS the placement rather than freezing a degenerate one
   *  — that's how the user gets the default layout back. */
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

  /** Persist a dragged CONSTRAINT dim placement (the placed dims — see
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

  /** Write a typed value onto a dimension's constraint, then re-solve.
   *
   *  The one seam BOTH edit paths (plain number and expression) go through,
   *  because the offset dim needs special care: it DISPLAYS |value| while the
   *  stored value is SIGNED, the sign being which side the copy sits on. Typing
   *  "3" into an inward offset must keep it inward — a bare `c.value = val`
   *  would silently flip it outward. Same abs-display trap as the drag path;
   *  centralising the write is what stops the two sites drifting apart. */
  private writeDimValue(c: SketchConstraint & { value: number }, val: number) {
    c.value = c.type === "offset" && c.value < 0 ? -Math.abs(val) : val;
    this.requestSolve();
    this.onState?.();
  }

  /** Add/replace the driving dimension on an entity, then re-solve. A dim gets
   *  its stable id at birth; a replacement inherits the replaced dim's id, so a
   *  parameter binding survives retyping the dimension. */
  private setDrivingDimension(c: SketchConstraint) {
    // the unordered pair of rounds a rim-gap dim spans. radialGap and
    // c2cDistance are the SAME user intent ("the gap between these two rims") in
    // two solver formulations — treating them as one target is what stops a
    // stale c2cDistance surviving when the pair becomes concentric (or the
    // reverse) and gets re-dimensioned.
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
      // offset: one dim per OPERATION, identified by the set of copies it
      // governs. Re-offsetting the same curves replaces the old dim (inheriting
      // its id, so a parameter binding survives); a different offset elsewhere
      // in the sketch is a different target and both survive.
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
    // requestSolve is a no-op once the solver is known dead, so on those
    // machines the value has to be written into the geometry here or it is
    // recorded and never seen. Harmless when the solver is alive: this is not
    // reached, and the solve is what moves anything.
    if (this.solverDead) this.applyDrivingDimsDirectly();
  }

  // --- parameter bindings on sketch dims -------------------------------------
  // While the sketch is OPEN its dims aren't in the document yet, so expression
  // bindings are recorded here (keyed `c:<constraintId>` / `e:<entityId>:<field>`)
  // and land atomically with the sketch commit (store.applyBindings inside the
  // same mutate). Bound dims render fx: and reopen their expression.
  private pendingBindings = new Map<string, { expr: string; kind: FieldKind; name?: string }>();

  /** the sketch feature id currently open for editing (null for a new sketch
   *  or when the editor is closed) — the store's cascade must not headlessly
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

  /** the driving expression for a bound dim key — pending wins over the doc. */
  private exprFor(key: string): string | undefined {
    return this.pendingBindings.get(key)?.expr ?? this.docBinding(key)?.expr;
  }

  /** Evaluate raw dim input for the binding slot `key`: a plain number in
   *  display units, or an expression in canonical units — including the
   *  `name=expr` form (names the dim's model parameter). The number/formula
   *  fork and the positivity rule for sketch dims live here (the label
   *  editor's plain-number path on UNBOUND dims re-checks positivity in
   *  sketchDimensions.beginEdit). `expr` is null for plain numbers; `name` is
   *  set only when the input renames the binding. */
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

  /** Raw label input on an entity dimension. Line length / circle diameter
   *  convert to their driving constraint (existing behavior) and bind there;
   *  solver-rigid direct fields (polygon radius, slot width…) bind as entity
   *  targets. Everything else: numbers only for now.
   *  defer: expressions on rectangle W/H + derived dims (slot length) — needs
   *  an auto-constraint conversion; revisit when a user asks for it. */
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
   *  live dim value — document bindings read the table, pending ones
   *  re-evaluate — then re-solve so the geometry follows. */
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
      this.armPreEdit(); // parameter sync is DERIVED — never an undo step
      this.requestSolve();
      this.refreshActive();
      this.onState?.();
    }
  }

  /** Projection refresh for the OPEN sketch (injected via
   *  store.onProjectionsApplied — the mirror of syncParamValues): patch the
   *  session copies of the updated projected entities, then re-solve so
   *  constrained geometry follows and the overlay repaints. The doc copy is
   *  NOT written while the sketch is open; finish() persists the session. */
  syncProjectedCurves(updates: ProjectionUpdate[]) {
    if (!this.active) return;
    let touched = false;
    for (const u of updates) {
      const i = this.entities.findIndex((x) => x.type === "projected" && x.id === u.entity);
      const e = this.entities[i];
      if (!e || e.type !== "projected") continue;
      if (u.stale && e.stale) continue; // already flagged — nothing changes
      this.entities[i] = applyProjectionUpdate(e, u);
      touched = true;
    }
    if (touched) {
      this.armPreEdit(); // projection refresh is DERIVED — never an undo step
      this.requestSolve();
      this.refreshActive();
    }
  }

  /** Geometry-beats-label: called from a dimension badge's pointerdown when the
   *  badge sits over sketch geometry (common at low zoom — the badge is a DOM
   *  element above the canvas, so the canvas never sees the click). Select the
   *  entity under the cursor and return true; the badge then skips its
   *  value-edit. False = nothing underneath, the badge behaves normally. */
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

  /** Arbitrate a click that landed on a label or glyph while the dimension tool
   *  is active. Dimensioning keeps every click it needs: one with picks already
   *  taken is mid-dimension (the second operand, or the placement), and one that
   *  lands on geometry names the next operand. Only a click on an idle
   *  annotation over empty space belongs to the annotation itself. A
   *  double-click always reaches the label regardless (SketchDimensions). */
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
    // Project picks 3D model geometry / committed sketch curves — it needs the
    // raw client coords, so it branches BEFORE the plane-point conversion.
    if (this.tool === "project") {
      e.preventDefault();
      void this.projectClick(e);
      return;
    }
    // A click on a plane turned edge-on cannot mean what it looks like it
    // means, so it is declined here — after Project, which picks 3D geometry in
    // client coords and does not care which way the plane is facing. Said out
    // loud: the old behaviour placed the point anyway, hundreds of millimetres
    // off the side, and a silent refusal would only be a quieter version of the
    // same puzzle.
    if (this.planeTooEdgeOn()) {
      e.preventDefault();
      setPrompt("The sketch plane is edge-on, turn the view to draw on it");
      return;
    }
    // Dimension takes the RAW plane point, and branches before snapAt's
    // early-return: snapping to a nearby vertex pulls the point off a circle's
    // rim (defeating the rim hit-test at high zoom), and a failed snap would
    // otherwise swallow the click entirely.
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

    if (this.tool === "select") {
      // grab a point to drag it — connected/constrained geometry follows
      const gp = this.pickPoint(p);
      if (gp) {
        this.dragFrom = gp.p.clone();
        this.dragEntIdx = gp.idx;
        this.dragStartClient = { x: e.clientX, y: e.clientY };
        this.dragMoved = false;
        this.dragShift = e.shiftKey;
        this.dragRefusedToast = false;
        this.dragSnapshot = JSON.parse(JSON.stringify(this.entities)); // for Esc-cancel revert
        try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
        return;
      }
      // no draggable vertex under the cursor → (de)select the entity body / area
      const raw = this.planePoint(e) ?? p;
      // DOUBLE-click a pattern's derived copy → edit the owning pattern (associative).
      // A SINGLE click must NOT edit — it selects the cell's profile area for extrude
      // (the whole point of a patterned hole/cell, esp. a thin sub-area carved by a
      // crossing curve, which is always within pick-tolerance of an outline edge).
      const derived = this.derivedEntities();
      const di = pickEntity(derived, raw, this.pickTol());
      const de = di >= 0 ? derived[di] : undefined;
      if (de && e.detail >= 2) {
        this.editPattern(de.id.split("#")[0] ?? de.id);
        return;
      }
      // DOUBLE-click text → re-open the text panel to edit it in place. (Text isn't
      // pickable as an entity — entitySegments is empty — so it's found via its glyph
      // group's bounding box, a generous hit that lands even between letters.)
      if (e.detail >= 2) {
        const te = this.textEntityAt(raw);
        if (te) {
          this.editText(te, e);
          return;
        }
      }
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
      // otherwise select a profile AREA to extrude — includes patterned cells and
      // sub-areas carved by a crossing curve
      const wr = this.overlay.activeRegionAt(raw);
      if (wr) {
        this.overlay.toggleRegionSelection(wr, e.shiftKey || e.ctrlKey || e.metaKey);
        return;
      }
      // empty space → clear both entity and area selection
      if (!e.shiftKey) {
        this.selected.clear();
        this.overlay.clearRegionSelection();
      }
      this.refreshActive();
      return;
    }
    if (PATTERN_TOOLS.has(this.tool)) return this.patternClick(p);
    if (this.tool === "arc") return this.arcClick(p);
    if (this.tool === "spline") return this.splineClick(p);
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
    if (this.tool === "trim") return this.trimClick(p);
    if (this.tool === "fillet") return this.filletClick(p);
    if (this.tool === "chamfer") return this.chamferClick(p);
    if (this.tool === "move" || this.tool === "copy") return this.moveClick(p);
    if (this.tool === "rotate") return this.rotateClick(p);
    if (this.tool === "scale") return this.scaleClick(p);
    if (this.tool === "offset") return this.offsetClick(p);
    if (this.tool === "extend") return this.extendClick(p);
    if (this.tool === "break") return this.breakClick(p);
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
      // fully determined by the three picked points — no dimension to type
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
        ? [{ name: "diameter", label: "⌀" }]
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
    if (this.constructionMode) ent.construction = true;
    this.entities.push(ent);
    this.refreshActive();
    this.overlay.setPreview([]);
    this.requestSolve();
    this.onState?.();
  }

  /** the smallest rectangle entity that contains `p`, or null — used to format text
   *  INSIDE a drawn box (centered + wrapped to the box width). */
  /** Plane-frame angle (radians) of the current view's screen-right direction. The
   *  sketch view squares to the plane but can sit at any 90° rotation (nearest-square
   *  entry — enterSketchView), so text is placed relative to what the user currently
   *  sees as horizontal, not the plane's raw +X (which may point up/down on screen). */
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

  /** Open the text panel for a placement. `explicitBox` is a dragged box; otherwise a
   *  click that lands inside a rectangle binds the text into it (centered + wrapped). */
  /** The text entity (if any) under a 2D sketch point — generous bounding-box hit. */
  /** Remove the in-progress text preview entity from the active list. Returns true
   *  if one was present (so callers can skip a repaint when nothing changed). */
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
        // live preview via a temporary entity on the active list — reuses the proven
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

  // --- patterns: click to place, drag to size, type counts, click to commit. Each
  // persists as an editable (associative) definition. Entity patterns (rect/circular)
  // replicate the current selection; presets emit holes. Delegates to PatternFlow
  // (see patternFlow.ts), which owns the placement/edit state live. -------------
  private patternClick(p: THREE.Vector2) {
    // entity patterns replicate the selection — drop projected reference
    // geometry from the sources BEFORE PatternFlow snapshots them
    if (ENTITY_PATTERNS.has(this.tool)) {
      for (const id of this.warnSelectedProjected()) this.selected.delete(id);
    }
    this.patternFlow.click(p);
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
  /** Commit a regular polygon as one parametric entity (rigid — the solver
   *  skips it; `angle` is the first-vertex angle in DEGREES). */
  private commitPolygon(center: THREE.Vector2, vertex: THREE.Vector2) {
    const r = center.distanceTo(vertex);
    if (r < 1e-4) return;
    const angle = (Math.atan2(vertex.y - center.y, vertex.x - center.x) * 180) / Math.PI;
    const e: ResolvedEntity = {
      type: "polygon", id: newEntityId(), x: center.x, y: center.y,
      radius: r, sides: Math.max(3, Math.round(this.polygonSides)), angle,
    };
    if (this.constructionMode) e.construction = true;
    this.entities.push(e);
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
    if (this.constructionMode) e.construction = true;
    this.entities.push(e);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
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
    this.dim.hide();
    this.commitCircle(center, r);
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

  private commitCircle(center: THREE.Vector2, r: number) {
    if (r < 1e-4) return;
    const ent: ResolvedEntity = { type: "circle", id: newEntityId(), radius: r, x: center.x, y: center.y };
    if (this.constructionMode) ent.construction = true;
    this.entities.push(ent);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
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
    this.dim.hide();
    const ent: ResolvedEntity = { type: "rectangle", id: newEntityId(), width: w, height: h, x: center.x, y: center.y };
    if (this.constructionMode) ent.construction = true;
    this.entities.push(ent);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  // --- three-point rectangle: click one full EDGE, then its thickness -----
  //
  // The tool the rectangle's `angle` field was added for. Clicking two corners
  // gives a rectangle a DIRECTION, which is the thing neither of the other two
  // rectangle tools can express — and it stays one rectangle rather than four
  // lines, so it keeps its W/H dimension, its "<rectId>~k" edge addressing and
  // its row in the browser tree.

  /** The rectangle for the current three points, with a typed W/H applied.
   *
   *  A typed WIDTH stretches the edge along its own direction (the angle is the
   *  user's, drawn, and must not be overwritten by a number). A typed HEIGHT
   *  replaces the thickness while keeping the side the cursor is on — otherwise
   *  entering a value would flip the rectangle to whichever side the sign of the
   *  raw distance happened to be. */
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
    this.dim.hide();
    const ent: ResolvedEntity = {
      type: "rectangle", id: newEntityId(),
      width: r.width, height: r.height, x: r.x, y: r.y,
      // Omitted when it is 0, so an axis-aligned rectangle drawn with this tool
      // is byte-identical to one drawn with the others.
      ...(r.angle ? { angle: r.angle } : {}),
    };
    if (this.constructionMode) ent.construction = true;
    this.entities.push(ent);
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  // --- mirror: click a line; reflect the multi-selection across it -------
  private mirrorClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    const axis = idx >= 0 ? this.entities[idx] : undefined;
    if (!axis || axis.type !== "line") return;
    const selectedSources = this.entities.filter((e) => this.selected.has(e.id) && e.id !== axis.id);
    // projected geometry is a fixed reference — mirror the rest of the selection
    // (it stays selected; the commit below clears the whole selection anyway)
    const projected = this.warnSelectedProjected();
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
    if (e.type === "text") {
      const at = rp(e.x, e.y); // reflect the anchor; keep the string/style (glyphs aren't mirrored)
      return { ...e, id, x: at.x, y: at.y };
    }
    // point
    const q = rp((e as Extract<ResolvedEntity, { type: "point" }>).x, (e as Extract<ResolvedEntity, { type: "point" }>).y);
    return { type: "point", id, x: q.x, y: q.y, ...c };
  }


  private onPointerMove(e: PointerEvent) {
    // right-DRAG is camera pan (viewport TRUCK), not a menu gesture — the same
    // 5 px rule the viewport's own context-click guard uses
    if (this.rightDownAt && !this.rightDragged &&
      Math.hypot(e.clientX - this.rightDownAt.x, e.clientY - this.rightDownAt.y) > 5) {
      this.rightDragged = true;
    }
    if (this.active && this.tool === "project") {
      this.projectHover(e);
      return;
    }
    if (this.active && this.tool === "dimension") {
      this.dimFlow.dimensionHover(e);
      return;
    }
    if (this.active && MODIFY_TOOLS.has(this.tool)) {
      this.modifyHover(e);
      return;
    }
    if (!this.active || this.tool === "select") {
      if (this.dragFrom) {
        if (!this.dragMoved) {
          const dx = e.clientX - this.dragStartClient.x, dy = e.clientY - this.dragStartClient.y;
          if (dx * dx + dy * dy < 16) return; // <4px: still a click — don't solve yet
          this.dragMoved = true;
        }
        const w = this.planePoint(e); // raw cursor; snapping off for smooth drag
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
          if (this.guardProjected(this.entities[md.idx])) {
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
      this.dim.position(e.clientX, e.clientY);
      this.overlay.setPreview([geom.preview]); // only the rubber-band redraws
    } else {
      this.overlay.setPreview([]);
    }
  }

  private onKey(e: KeyboardEvent) {
    // The dim box auto-focuses while drawing, so nearly every in-sketch Esc
    // arrives with an editable target — it must still cancel (same carve-out
    // extrudeTool.onKey has). Only Esc aimed at OUR dim box passes; any other
    // editor (dimension-label inline edit, rename fields) keeps handling its
    // own keys, and all non-Escape keys still never fire shortcuts while typing.
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
      // A selected dimension goes first: it is a more specific target than the
      // entity selection, and isEditableTarget above already returned if the
      // label's inline editor has focus, so this only fires once the editor is
      // closed (Esc) or was never opened (right-click).
      if (this.dims.deleteSelected()) {
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
      // the ORDER can be tested without a canvas — see escapeLayers.ts.
      const action = sketchEscapeAction({
        offsetPick: !!this.offsetPick,
        dragging: !!(this.dragFrom || this.moveDrag),
        pendingGeometry:
          !!this.base || !!this.arcStart || this.filletFirst != null || this.splinePts.length > 0 ||
          this.clickPts.length > 0 || this.dimFlow.picking || !!this.dimFlow.plan ||
          this.constraintTools.hasPending(),
        selection: this.selected.size > 0,
        tool: this.tool,
      });
      if (action === "cancel-offset") { this.cancelOffset(); return; }
      if (action === "cancel-drag") {
        // cancel an in-progress drag: revert geometry to its pre-drag positions
        if (this.dragSnapshot) this.entities = this.dragSnapshot;
        this.dragSnapshot = null;
        this.dragFrom = null;
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
        this.filletFirst = null;
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
        // Nothing left to cancel: the press means "I'm done here".
        //
        // It COMMITS rather than discards. Escape cancels a tool everywhere else
        // in the app, but a sketch is not a tool — it is a document edit the user
        // has been building for minutes, and the same key that walked them out of
        // a half-drawn line must not also be the key that silently deletes the
        // twenty entities behind it. This is the same finish(true) every 3D
        // command already performs on an open sketch, so leaving by Escape and
        // leaving by pressing Extrude put the same feature in the timeline.
        //
        // And the press stops here. It has been spent: without this the SAME
        // keydown reaches the global handler, which — seeing a sketch that is no
        // longer active — would go on to clear the model selection underneath it.
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
      if (this.base) {
        e.preventDefault();
        this.commitFromCursor(this.lastCursor);
        return;
      }
    }
    // tool shortcuts inside the sketch
    const k = e.key.toLowerCase();
    // Q/E deliberately NOT handled here: they fall through to the global keymap
    // (q=Press/Pull, e=Extrude), which finishes the sketch and starts the tool —
    // the sketch view now opens straightened to the nearest rotation, so the old
    // Q/E view-roll is no longer needed.
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
    // THE SNAPPED POINT, unless a typed length or angle overrides it.
    //
    // This rebuilt the endpoint from (length, angle) unconditionally, which
    // sends every point the cursor snapped to on a round trip out to polar and
    // back — through a division by 180, a multiplication by pi and two
    // trigonometric functions — and lands it a few parts in a million from
    // where it started. A corner placed exactly on a grid intersection was
    // committed at 5.999995816, and the whole of the sketcher's exact
    // reasoning is downstream of that: onLattice() allows a millionth and
    // rejected it, so the grid branch of the horizontal/vertical inference
    // never fired for a drawn line and the three-degree GUESS was carrying the
    // entire feature. Typed values still have to be reconstructed, because the
    // number the user typed is the one that has to come true rather than the
    // one the cursor happened to be at.
    const end = typedLen || typedAng
      ? new THREE.Vector2(a.x + Math.cos(ar) * len, a.y + Math.sin(ar) * len)
      : cursor.clone();
    const ent: ResolvedEntity = { type: "line", id: "", x1: a.x, y1: a.y, x2: end.x, y2: end.y };
    const dims: Record<string, number> = { length: len, angle: ang };
    return { dims, preview: this.entityCurve(ent), entity: ent };
  }

  private commitFromCursor(cursor: THREE.Vector2) {
    if (!this.base) return;
    const { entity } = this.computeGeometry(this.base, cursor);
    if (this.constructionMode) entity.construction = true;
    entity.id = newEntityId(); // stamp a stable id (computeGeometry left it "")
    this.entities.push(entity);
    if (this.tool === "line" && entity.type === "line") {
      const end = new THREE.Vector2(entity.x2, entity.y2);
      // clicked back on the start point → close the loop and end the chain
      const closing = this.chainStart != null && end.distanceTo(this.chainStart) < 1e-3;
      // Auto-infer horizontal/vertical. The closing segment gets the same
      // look with the GUESS switched off: its direction was not chosen, it is
      // whatever is left between the two ends already placed, so three degrees
      // of tolerance there would be inventing an intent nobody had. Exactly on
      // an axis is not a guess, and skipping the segment outright was leaving a
      // closed profile with no constraint on it anywhere. A typed angle is the
      // user having said it already, and still wins over both.
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

  private showDimFields() {
    const defs =
      this.tool === "rectangle"
        ? [{ name: "width", label: "W" }, { name: "height", label: "H" }]
        : this.tool === "circle"
          ? [{ name: "diameter", label: "⌀" }]
          : [
              { name: "length", label: "L" },
              { name: "angle", label: "∠", kind: "angle" as const },
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
    if (noSnap) return { p: p2d, kind: "free" as SnapKind, world, guides: [] as SnapGuide[] };
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
    };
  }

  /** The grid spacing currently on screen, which is what the cursor snaps to.
   *  Measured at the plane origin, the same place the grid is drawn from. */
  private snapStep(): number {
    return snapLatticeStep(this.planeMmPerPx());
  }

  private showSnap(
    hit: { kind: SnapKind; world: THREE.Vector3; p?: THREE.Vector2; guides?: SnapGuide[] } | null,
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
    if (!hit || !showsSnapMarker(this.tool, hit.kind)) {
      this.overlay.setSnap(null);
      this.snapWorld = null;
      return;
    }
    this.overlay.setSnap(hit.world, hit.kind, this.viewport.camera);
    this.snapWorld = hit.world.clone();
    this.snapScaleSeen = 0; // a new point: size it now rather than next frame
    this.updateSnapScale();
  }

  /** Keep the snap ring a constant size on screen.
   *
   *  Its scale was written only when the pointer moved, and it is a SCREEN
   *  quantity held as world geometry, so any zoom that did not come with a
   *  pointer move left it at the millimetres it had. Wheel in on the point it
   *  was standing on and it grew with everything else: fourteen notches took it
   *  from 6 pixels across to 44, an orange donut sitting over the drawing with
   *  nothing left to say. It follows the camera now, like the grid and the
   *  annotations it sits among, and on the same 5% band, so a wheel-zoom costs
   *  about one write per notch. */
  private snapWorld: THREE.Vector3 | null = null;
  private snapScaleSeen = 0;
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

  /** Derived (copy) entities from every pattern — render/region only, never edited
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
      // question being asked right now, so it wins over a selection that may
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

  /** Snap targets the FACE contributes: its centre, the centre of every hole
   *  through it, its corners, and the middle of each of its sides.
   *
   *  Priorities 70-76 — under a placed point (110), an endpoint (100) and a
   *  midpoint (80), over a projected polyline's interior samples (60). The face
   *  is scenery you are drawing on top of, so anything you actually drew wins
   *  where the two land in the same place; but it is exact model geometry, so it
   *  outranks a tessellation sample.
   *
   *  Derived from the footprint enter() computes once per session, because the
   *  body under an open sketch cannot change. */
  private faceAnchorCandidates(): SnapCandidate[] {
    const out: SnapCandidate[] = footprintAnchors(this.footprint).map((p) => ({
      p,
      kind: "center" as SnapKind,
      priority: 70,
    }));
    // The face's own corners and the middle of each of its sides. Ranked among
    // themselves the way the sketch's are — a corner is an endpoint, a side
    // midpoint is a midpoint — but the whole family stays under the sketch's
    // own 80, so a line you drew across the face still wins where its midpoint
    // lands on the face's.
    const { corners, sides } = boundaryAnchors(this.footprintEdges);
    for (const p of corners) out.push({ p, kind: "endpoint", priority: 76 });
    for (const p of sides) out.push({ p, kind: "midpoint", priority: 72 });
    return out;
  }

  /** A small cross on each face anchor, so the target is visible before the
   *  cursor is near enough to snap to it. Same glyph the sketch's own points and
   *  circle centres wear, drawn dimmer: it marks somewhere you can aim, not
   *  something in the sketch. */
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
  /** raw (unsnapped) screen point → sketch-plane 2D (mm). THE screen→plane
   *  conversion: it goes through the plane itself, so it is correct on a
   *  datum/XZ/YZ plane whose axes need not line up with the screen's — callers
   *  outside the pointer handlers (e.g. the dimension labels' drag) use it
   *  rather than scaling screen pixels by a mm-per-pixel factor. */
  private planePointAt(clientX: number, clientY: number): THREE.Vector2 | null {
    // Nothing on a plane turned edge-on can be aimed at: the ray still meets it
    // and the answer is still exact, but a pixel is worth metres there, so the
    // point lands off the side of the world. planeGraze has the measurements.
    // Guarded HERE rather than at each caller because this is the one screen to
    // plane conversion, and every caller already handles a null.
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
  /** hover-highlight the entity under the cursor in red */
  private modifyHover(e: PointerEvent) {
    // An offset being placed owns the preview: this is the MODIFY_TOOLS hover
    // branch and it runs on every move, so without this it would overwrite the
    // offset's live preview with a plain hover highlight one frame later.
    if (this.offsetPick) { this.offsetMove(e); return; }
    const p = this.planePoint(e);
    if (!p) return;
    const idx = pickEntity(this.entities, p, this.pickTol());
    const preview: THREE.Object3D[] = [];
    const first = this.filletFirst != null ? this.entities[this.filletFirst] : undefined;
    if (first) preview.push(...curveObjects([first], this.plane, 0x33aaff, true));
    const hit = idx >= 0 ? this.entities[idx] : undefined;
    if (hit) preview.push(...curveObjects([hit], this.plane, 0xff5555, true));
    this.overlay.setPreview(preview);
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
    // a right-DRAG panned the camera — don't turn its release into a menu
    const dragged = this.rightDragged;
    this.rightDownAt = null;
    this.rightDragged = false;
    if (dragged) return;
    if (this.tool === "dimension") { this.openDimensionMenu(e); return; }
    if (this.tool === "offset") { this.openOffsetMenu(e); return; }
    if (this.tool !== "select") return;
    const raw = this.planePoint(e);
    const idx = raw ? pickEntity(this.entities, raw, this.pickTol()) : -1;
    const hit = idx >= 0 ? this.entities[idx] : undefined;
    if (hit) {
      const id = hit.id;
      if (!this.selected.has(id)) { this.selected = new Set([id]); this.refreshActive(); }
    }
    if (!this.selected.size) return; // nothing to act on → let nav handle it
    e.preventDefault();
    const n = this.selected.size;
    const linked = this.selectedProjectedIds().size;
    const items: CtxItem[] = [
      ...(linked
        ? [{ label: linked > 1 ? `Break Link (${linked})` : "Break Link", onClick: () => this.breakSelectedLinks() }]
        : []),
      { label: n > 1 ? `Delete ${n} entities` : "Delete", danger: true, onClick: () => this.deleteSelected() },
    ];
    contextMenu(e.clientX, e.clientY, items);
  }

  /** Fusion's in-command marking menu for the Dimension tool: the overrides the
   *  picks alone can't express. "Pick Circle/Arc Tangent" is armed BEFORE the
   *  pick it applies to and is consumed by it (never sticky), which is the only
   *  way to say "measure to the EDGE of this circle, not its centre". */
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

  /** Fusion's in-command marking menu for the Offset tool: the two things the
   *  cursor alone can't say — whether to take the whole connected chain, and
   *  which side to land on when the cursor is nowhere near the curve. */
  private openOffsetMenu(e: MouseEvent) {
    e.preventDefault();
    const pick = this.offsetPick;
    contextMenu(e.clientX, e.clientY, [
      {
        label: "Chain Selection", checked: this.offsetChainMode,
        onClick: () => {
          this.offsetChainMode = !this.offsetChainMode;
          setPrompt(this.offsetChainMode
            ? "Chain Selection on, the whole connected profile offsets as a unit"
            : "Chain Selection off, only the clicked curve offsets");
        },
      },
      {
        label: "Flip", disabled: !pick,
        onClick: () => { if (pick) pick.side = -pick.side; },
      },
      { separator: true, label: "" },
      { label: "OK", disabled: !pick, onClick: () => { if (pick) this.commitOffset(); } },
      { label: "Cancel", disabled: !pick, onClick: () => this.cancelOffset() },
    ]);
  }

  private setDimRoundPref(pref: "radius" | "diameter") {
    this.dimFlow.setRoundPref(pref);
    this.dimFlow.refreshDimPlan();
    const plan = this.dimFlow.plan;
    if (plan) setPrompt(plan.hint);
  }

  /** Break Link (context menu): the selected projected entities become native
   *  geometry with the SAME ids — attached constraints/dims stay valid, the
   *  geometry unfreezes, and the associative refresh skips them from now on
   *  (they are no longer type "projected"). Breaking one member of a
   *  multi-curve group (a face boundary's siblings) breaks only that member —
   *  the others stay linked (Fusion behavior). */
  private breakSelectedLinks() {
    const ids = this.selectedProjectedIds();
    if (!ids.size) return;
    this.entities = breakLink(this.entities, ids);
    this.afterModify(); // selection stays: the entities still exist, now native
  }
  private trimClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.guardProjected(this.entities[idx])) return;
    this.entities = trimEntity(this.entities, idx, p);
    this.afterModify();
  }
  private filletClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (this.guardProjected(idx >= 0 ? this.entities[idx] : undefined)) return;
    if (idx < 0 || this.entities[idx]?.type !== "line") return;
    if (this.filletFirst == null) {
      this.filletFirst = idx;
      return;
    }
    if (idx === this.filletFirst) return;
    const second = idx;
    const first = this.filletFirst;
    this.dim.show([{ name: "radius", label: "R", kind: "length" }], () =>
      this.applyFillet(first, second),
    );
  }
  private applyFillet(iA: number, iB: number) {
    const r = this.dim.getValue("radius") ?? 2;
    const res = filletCorner(this.entities, iA, iB, r);
    if (res) this.entities = res;
    this.filletFirst = null;
    this.dim.hide();
    this.afterModify();
  }
  private chamferClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (this.guardProjected(idx >= 0 ? this.entities[idx] : undefined)) return;
    if (idx < 0 || this.entities[idx]?.type !== "line") return;
    if (this.filletFirst == null) {
      this.filletFirst = idx;
      return;
    }
    if (idx === this.filletFirst) return;
    const second = idx;
    const first = this.filletFirst;
    this.dim.show([{ name: "distance", label: "D", kind: "length" }], () =>
      this.applyChamfer(first, second),
    );
  }
  private applyChamfer(iA: number, iB: number) {
    const d = this.dim.getValue("distance") ?? 2;
    const res = chamferCorner(this.entities, iA, iB, d);
    if (res) this.entities = res;
    this.filletFirst = null;
    this.dim.hide();
    this.afterModify();
  }

  /** Projected geometry is FIXED reference geometry: every modify/transform seam
   *  calls this and bails with one consistent toast. Delete stays allowed. */
  private guardProjected(e: ResolvedEntity | undefined): boolean {
    if (e?.type !== "projected") return false;
    toast(PROJECTED_FIXED_MSG);
    return true;
  }

  /** ids of the currently-selected projected (linked reference) entities. */
  private selectedProjectedIds(): Set<string> {
    return new Set(
      this.entities.filter((e) => e.type === "projected" && this.selected.has(e.id)).map((e) => e.id),
    );
  }

  /** The selected projected (linked reference) ids, toasting PROJECTED_FIXED_MSG
   *  once when any exist — the shared seam for tools that transform the
   *  selection. Each caller keeps its own retention semantics (deselect /
   *  keep-selected / skip from copies). */
  private warnSelectedProjected(): Set<string> {
    const ids = this.selectedProjectedIds();
    if (ids.size) toast(PROJECTED_FIXED_MSG);
    return ids;
  }

  /** replace each selected entity with map(e) (flattened); others unchanged. Owns
   *  the selection: it re-selects the transform's output, so a rotate that explodes
   *  a rectangle into fresh-id lines leaves those lines selected (not a stale id). */
  private transformSelection(map: (e: ResolvedEntity) => ResolvedEntity[]) {
    const next: ResolvedEntity[] = [];
    const sel = new Set<string>();
    // fixed reference geometry: keep it (and its selection) untouched
    const projected = this.warnSelectedProjected();
    for (const e of this.entities) {
      if (this.selected.has(e.id) && !projected.has(e.id)) {
        for (const m of map(e)) { next.push(m); sel.add(m.id); }
      } else {
        next.push(e);
        if (projected.has(e.id)) sel.add(e.id);
      }
    }
    this.entities = next;
    this.selected = sel;
    this.afterModify();
  }

  /** keep the id for a single-entity result; give an exploded result (a rotated
   *  rectangle → 4 lines) fresh ids so nothing collides. */
  private reid(rot: ResolvedEntity[]): ResolvedEntity[] {
    return rot.length === 1 ? rot : rot.map((r) => ({ ...r, id: newEntityId() }));
  }

  /** Move/Copy: click a base point, then a destination — translate the whole
   *  selection. Move mutates in place; Copy leaves the originals and selects the copies. */
  private moveClick(p: THREE.Vector2) {
    if (!this.selected.size) { toast("Select entities first, then Move/Copy"); return; }
    if (!this.moveBase) { this.moveBase = p.clone(); toast("Click the destination point"); return; }
    const dx = p.x - this.moveBase.x, dy = p.y - this.moveBase.y;
    this.moveBase = null;
    if (this.tool === "copy") {
      const copies: ResolvedEntity[] = [];
      const sel = new Set<string>();
      const projected = this.warnSelectedProjected(); // linked — can't clone the link
      for (const e of this.entities) {
        if (!this.selected.has(e.id) || projected.has(e.id)) continue;
        const id = newEntityId();
        copies.push(translated(e, dx, dy, id));
        sel.add(id);
      }
      this.entities = [...this.entities, ...copies];
      this.selected = sel; // leave the copies selected (Fusion-style)
      this.afterModify();
    } else {
      this.transformSelection((e) => [translated(e, dx, dy, e.id)]);
    }
  }

  /** Rotate the selection about a clicked center by a typed angle (degrees). */
  private rotateClick(p: THREE.Vector2) {
    if (!this.selected.size) { toast("Select entities first, then Rotate"); return; }
    const cx = p.x, cy = p.y;
    this.dim.show([{ name: "angle", label: "∠", kind: "angle" }], () => {
      const ang = ((this.dim.getValue("angle") ?? 0) * Math.PI) / 180;
      this.dim.hide();
      this.transformSelection((e) => this.reid(rotated(e, cx, cy, ang, e.id)));
    });
    toast("Rotate: type an angle in degrees");
  }

  /** Scale the selection about a clicked base point by a typed factor. */
  private scaleClick(p: THREE.Vector2) {
    if (!this.selected.size) { toast("Select entities first, then Scale"); return; }
    const cx = p.x, cy = p.y;
    this.dim.show([{ name: "factor", label: "×", kind: "count" }], () => {
      const f = this.dim.getValue("factor") ?? 1;
      this.dim.hide();
      if (f > 0) this.transformSelection((e) => [scaled(e, cx, cy, f, e.id)]);
    });
    toast("Scale: type a factor (e.g. 2 or 0.5)");
  }
  /** Offset (Fusion parity), two-phase: click a curve, then move the cursor to
   *  choose the SIDE and distance — or type one — and click again (or Enter) to
   *  apply. `side` and `mag` are kept apart on purpose: the box displays the
   *  magnitude, so folding them into one signed number is how typing a value
   *  silently flips an inward offset outward (the abs-display trap). */
  private offsetPick: { idx: number; side: number; mag: number } | null = null;
  /** Fusion's in-command "Chain Selection" toggle, default ON: offset the whole
   *  connected chain rather than only the clicked curve. */
  private offsetChainMode = true;

  private offsetClick(p: THREE.Vector2) {
    if (this.offsetPick) { this.commitOffset(); return; } // second click applies
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0) return;
    const e = this.entities[idx];
    if (!e || this.guardProjected(e)) return;
    // Nothing may end in silence here: the user is mid-gesture, and a tool that
    // does nothing without saying why reads as broken.
    if (e.type === "text") { toast("Offset doesn't apply to sketch text"); return; }
    if (e.type === "point") { toast("Offset needs a curve, not a point"); return; }
    this.offsetPick = { idx, side: 1, mag: 0 };
    this.dim.show(
      [{ name: "offset", label: "Offset", kind: "length" }],
      () => this.commitOffset(),
      () => this.cancelOffset(),
    );
    setPrompt("Move to pick the side, or type a distance · Enter · Esc");
  }

  /** The offset result for the current pick, honouring Chain Selection. Chain
   *  first (a connected profile offsets as a unit), falling back to the single
   *  curve — which is also what a lone curve or a junction lands on. */
  private offsetResultFor(idx: number, dist: number): OffsetResult | null {
    if (Math.abs(dist) < 1e-6) return null;
    return (this.offsetChainMode ? offsetChain(this.entities, idx, dist) : null)
      ?? offsetEntity(this.entities, idx, dist);
  }

  /** Live side/distance + preview while the offset is being placed. */
  private offsetMove(ev: PointerEvent) {
    const pick = this.offsetPick;
    const p = this.planePoint(ev);
    const src = pick ? this.entities[pick.idx] : undefined;
    if (!pick || !src || !p) return;
    const signed = signedOffsetAt(src, p);
    const typed = this.dim.isUserDriven("offset") ? this.dim.getValue("offset") : null;
    if (typed !== null) {
      // Once a value is typed, the SIGN the user wrote owns the side — that is
      // what the minus is FOR, and the old tool worked that way. Previously the
      // cursor always won, so typing -1 silently offset outward and the minus
      // looked ignored. Clear the field to hand the side back to the cursor.
      pick.mag = Math.abs(typed);
      if (typed !== 0) pick.side = typed < 0 ? -1 : 1;
    } else if (signed !== null) {
      if (Math.abs(signed) > 1e-6) pick.side = signed < 0 ? -1 : 1;
      pick.mag = Math.abs(signed);
      this.dim.updateFromCursor({ offset: pick.mag });
    }
    this.dim.position(ev.clientX, ev.clientY);
    const res = this.offsetResultFor(pick.idx, pick.side * pick.mag);
    const added = res ? res.entities.slice(this.entities.length) : [];
    // keep the source highlighted so it stays obvious what is being offset
    const preview = [...curveObjects([src], this.plane, 0x33aaff, true)];
    if (added.length) preview.push(...curveObjects(added, this.plane, PREVIEW_COLOR, true));
    this.overlay.setPreview(preview);
  }

  private commitOffset() {
    const pick = this.offsetPick;
    if (!pick) return;
    // An empty box CANCELS. It used to fall back to `?? 1`, so pressing Enter on
    // an untouched field silently produced a 1 mm offset nobody asked for.
    if (this.dim.isUserDriven("offset")) {
      const typed = this.dim.getValue("offset");
      if (typed === null) { toast("Offset: type a distance, or Esc to cancel"); return; }
      // same rule as the live preview: a typed sign is the side (see offsetMove)
      pick.mag = Math.abs(typed);
      if (typed !== 0) pick.side = typed < 0 ? -1 : 1;
    }
    if (pick.mag < 1e-6) { toast("Offset: type a distance, or Esc to cancel"); return; }
    const res = this.offsetResultFor(pick.idx, pick.side * pick.mag);
    this.offsetPick = null;
    this.dim.hide();
    if (!res) {
      toast("Offset: that distance collapses the geometry");
      this.overlay.setPreview([]);
      return;
    }
    this.entities = res.entities;
    if (res.linked && res.pairs.length) {
      // the associative link + its single editable dimension
      this.setDrivingDimension({ type: "offset", pairs: res.pairs, value: pick.side * pick.mag });
    } else if (!res.linked) {
      toast("Offset copy created, not linked to the source (this shape type is rigid)");
    }
    this.afterModify();
  }

  private cancelOffset() {
    this.offsetPick = null;
    this.dim.hide();
    this.overlay.setPreview([]);
    setPrompt("Offset: click a curve to offset");
  }
  private extendClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.guardProjected(this.entities[idx])) return;
    const res = extendLine(this.entities, idx, p);
    if (res) this.entities = res;
    this.afterModify();
  }
  private breakClick(p: THREE.Vector2) {
    const idx = pickEntity(this.entities, p, this.pickTol());
    if (idx < 0 || this.guardProjected(this.entities[idx])) return;
    this.entities = breakAt(this.entities, idx, p);
    this.afterModify();
  }
  /** add a persistent geometric constraint and re-solve (the solver maintains
   *  all constraints together, not just the one you applied). Delegates to
   *  ConstraintTools (see constraintTools.ts), which owns the 9 click flows. */
  private constraintClick(p: THREE.Vector2) {
    this.constraintTools.click(p);
  }

  // --- Project (Fusion-style): click 3D model edges, body faces (→ boundary),
  // or committed sketch curves; each pick calls the projectGeometry aux-op
  // against the timeline-PREFIX document (store.projectGeometry truncates) and
  // lands purple linked "projected" entities in the open sketch immediately. ---

  /** the committed sketch feature `id`, when it is a sketch */
  private sourceSketch(id: string): Extract<Feature, { type: "sketch" }> | null {
    const f = this.store?.document.features.find((x) => x.id === id);
    return f && f.type === "sketch" ? f : null;
  }

  /** a committed sketch's REAL entity by id, with its owning sketch feature —
   *  derived pattern copies (ids carry "#") resolve to null: they don't exist
   *  in the document, so the sidecar could never re-find them. */
  private committedSource(
    sketchId: string,
    entityId: string,
  ): { sketch: Extract<Feature, { type: "sketch" }>; entity: ResolvedEntity } | null {
    const sk = this.sourceSketch(sketchId);
    if (!sk || !this.store) return null;
    const entity = resolveRealEntities(sk, this.store.document.parameters).find((x) => x.id === entityId);
    return entity ? { sketch: sk, entity } : null;
  }

  /** hover feedback for the Project tool: model edge/face highlight in Edges &
   *  faces AND Body silhouette modes (the model is dimmed 0.25 in sketch view
   *  but still raycastable; there is no body-level hover in the viewport, so a
   *  silhouette pick hovers the face/edge that will resolve to its body); a
   *  committed curve highlight via the preview layer in Sketch curves mode. */
  private projectHover(e: PointerEvent) {
    if (this.projectPanel.filter !== "sketchCurves") {
      this.overlay.setPreview([]);
      this.viewport.hoverEntity(this.viewport.pickEntity(e.clientX, e.clientY));
      return;
    }
    this.viewport.hoverEntity(null);
    const hit = this.overlay.committedCurveAt(e.clientX, e.clientY, (w) => this.viewport.projectToScreen(w));
    const src = hit ? this.committedSource(hit.sketchId, hit.entityId) : null;
    this.overlay.setPreview(
      src ? curveObjects([src.entity], this.overlay.planeFor(src.sketch.plane), 0x33aaff, true) : [],
    );
    this.viewport.requestRender();
  }

  /** does an already-placed projected entity carry (a match selector for) this
   *  edge fingerprint? Tolerant compare — fps carry float noise, never compare
   *  them byte-for-byte. */
  private hasProjectedFp(fp: EdgeFingerprint): boolean {
    return this.entities.some((x) => {
      if (x.type !== "projected") return false;
      const s = x.source;
      if (s.kind !== "edge" && s.kind !== "faceBoundary") return false;
      return s.sel.kind === "edge" && s.sel.by === "match" && fpClose(s.sel.fp, fp);
    });
  }

  /** One Project pick: resolve what's under the cursor into a ProjectedSource,
   *  run the op, land the returned curves as projected entities. Await-guarded
   *  by projectBusy so double-clicks can't race two calls. */
  private async projectClick(e: PointerEvent) {
    if (this.projectBusy || !this.store) return;
    let source: ProjectedSource | null = null;
    if (this.projectPanel.filter === "sketchCurves") {
      const hit = this.overlay.committedCurveAt(e.clientX, e.clientY, (w) => this.viewport.projectToScreen(w));
      if (!hit) {
        // nothing committed under the cursor — the ACTIVE sketch's own entities
        // are never valid sources (checked second: a projection usually lies
        // screen-coincident with its source, and the source must stay pickable)
        const p = this.planePoint(e);
        if (p && pickEntity(this.entities, p, this.pickTol()) >= 0) toast("Can't project the active sketch's own curves");
        return;
      }
      if (!this.committedSource(hit.sketchId, hit.entityId)) {
        toast("Pattern copies can't be projected, pick the pattern's source curve");
        return;
      }
      const dup = this.entities.some(
        (x) =>
          x.type === "projected" &&
          x.source.kind === "sketchCurve" &&
          x.source.sketch === hit.sketchId &&
          x.source.entity === hit.entityId,
      );
      if (dup) {
        toast("That curve is already projected into this sketch");
        return;
      }
      source = { kind: "sketchCurve", sketch: hit.sketchId, entity: hit.entityId };
    } else {
      const hit = this.viewport.pickEntity(e.clientX, e.clientY);
      if (!hit) return;
      const body =
        hit.kind === "edge"
          ? hit.edge.body
          : this.viewport.faceIdToBodyId(hit.faceId);
      if (!body) return;
      if (this.projectPanel.filter === "silhouette") {
        // any face/edge hit resolves to its whole BODY — the HLR outline source
        const dup = this.entities.some(
          (x) => x.type === "projected" && x.source.kind === "silhouette" && x.source.body === body,
        );
        if (dup) {
          toast("That body's silhouette is already projected into this sketch");
          return;
        }
        source = { kind: "silhouette", body };
      } else if (hit.kind === "edge") {
        // NOT hit.selector: the picker's nearest point is the line's mid VERTEX,
        // which for a 2-point straight edge is an ENDPOINT — a corner shared by
        // three edges that "nearest" (center-distance) then resolves to the
        // wrong one. The middle segment's midpoint is on (or near) the curve
        // and never a corner.
        const pts = hit.edge.points;
        const k = Math.max(0, Math.ceil(pts.length / 2) - 1);
        const a = pts[k]!, b = pts[Math.min(pts.length - 1, k + 1)]!;
        source = {
          kind: "edge", body,
          sel: { kind: "edge", by: "nearest", point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] },
        };
      } else {
        // the raycast hit point re-finds exactly the clicked face: it lies ON
        // the face's material, so by:"nearest" distance is 0 there and > 0 for
        // every other face. NOT the face centroid (which can fall off the
        // material — a washer's annular face — and tie with another face), and
        // NOT the picker's own selector (may be a by:"normal" GROUP hit, too
        // broad for one face's boundary).
        source = { kind: "faceBoundary", body, sel: { kind: "face", by: "nearest", point: hit.point } };
      }
    }

    this.projectBusy = true;
    // Session identity: enter() always assigns a fresh entities array, so if the
    // sketch was finished and a NEW one started while the op was in flight (a
    // realistic window — cold-cache prefix rebuilds take seconds), the identity
    // check below rejects the stale reply instead of landing curves computed
    // against the old sketch's plane and timeline prefix.
    const session = this.entities;
    let results;
    try {
      results = await this.store.projectGeometry(this.plane.serialize(), [source], this.editingId);
    } finally {
      this.projectBusy = false;
    }
    if (!this.active || this.tool !== "project" || this.entities !== session) return; // finished/switched/re-entered mid-flight
    const r = results[0];
    if (!r) {
      toast("geometry engine unavailable");
      return;
    }
    if (!r.ok) {
      toast(r.error ?? "projection failed"); // sidecar message verbatim ("created after this sketch"…)
      return;
    }
    // body-edge duplicates are detected against the returned fingerprints (the
    // sketch-curve case was pre-checked above — its ids are stable)
    const fresh = r.curves.filter(({ fp }) => !(fp && this.hasProjectedFp(fp)));
    const skipped = r.curves.length - fresh.length;
    if (skipped) toast(skipped === r.curves.length ? "That edge is already projected into this sketch" : `${skipped} already-projected edge${skipped > 1 ? "s" : ""} skipped`);
    if (!fresh.length) return;
    // multi-curve picks (a face boundary, a projected rectangle) emit sibling
    // entities sharing source.group = the FIRST sibling's entity id (stable:
    // entity ids are birth-stamped and survive edits)
    const ids = fresh.map(() => newEntityId());
    const group = ids.length > 1 ? { group: ids[0]! } : {};
    fresh.forEach(({ fp, curve }, i) => {
      // NOTE (plan step 4): a faceBoundary source persists with a per-edge
      // by:"match" sel — the rebuild refresh handler must resolve it via
      // resolve_edges (not resolve_faces) when it lands.
      const src: ProjectedSource =
        source.kind === "sketchCurve"
          ? // `index: i` is sound because sketch-curve results carry no fps, so
            // the dedup filter above never drops any — i IS the edge index in
            // the sidecar's deterministic _entity_edges order (the refresh
            // handler's authoritative sibling correspondence).
            { kind: "sketchCurve", sketch: source.sketch, entity: source.entity, ...group, ...(fresh.length > 1 ? { index: i } : {}) }
          : source.kind === "silhouette"
            ? // whole-body source: no selector; the refresh re-runs HLR and
              // re-matches the sibling curves (see _recompute_projections)
              { kind: "silhouette", body: source.body, ...group }
            : { kind: source.kind, body: source.body, sel: fp ? { kind: "edge", by: "match", fp } : source.sel, ...group };
      this.entities.push({ type: "projected", id: ids[i]!, source: src, curve });
    });
    this.refreshActive();
    this.requestSolve();
    this.onState?.();
  }

  /** Drop constraints that reference an entity that no longer exists (or is the
   *  wrong type) — e.g. after trim/break removes or splits a constrained line.
   *  Projected entities count via their CURVE kind (curveKind: a projected line
   *  is a valid line operand). NOTE: the switch is exhaustive on purpose — before
   *  step 5 the value-dim/fix/collinear/equalRadius/tangent2 types fell through
   *  and were silently dropped by every modify op; the `satisfies never` default
   *  makes a future SketchConstraint variant a tsc error here, not a silent drop. */
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
        e.type === "line" || e.type === "arc" || e.type === "spline" || e.type === "point" ||
        (e.type === "projected" && e.curve.kind !== "circle"),
    );
    // entities exposing at least one dimensionable reference point (p2p/p2l/fix targets)
    const refIds = ids((e) => dimRefPoints(e).length > 0);
    const rectIds = ids((e) => e.type === "rectangle");
    // A line OPERAND is either a live line entity or a rectangle EDGE
    // ("<rectId>~<k>", k = 0..3 — see types.ts). Every line-operand check goes
    // through here: a bare `lineIds.has(id)` would reject every rect-edge dim
    // and silently drop it on the next trim/fillet/delete.
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
        case "coincident": return endIds.has(c.e1) && endIds.has(c.e2);
        case "concentric": return roundIds.has(c.c1) && roundIds.has(c.c2);
        case "midpoint": return endIds.has(c.e) && hasLineOperand(c.line);
        case "symmetric": return endIds.has(c.e1) && endIds.has(c.e2) && hasLineOperand(c.line);
        case "radius": return roundIds.has(c.e);
        case "p2pDistance": return refIds.has(c.e1) && refIds.has(c.e2);
        case "p2lDistance": return refIds.has(c.e) && hasLineOperand(c.line);
        // rim (edge-to-edge) dims — a round operand is a circle OR an arc
        case "radialGap": return roundIds.has(c.inner) && roundIds.has(c.outer);
        case "c2cDistance": return roundIds.has(c.c1) && roundIds.has(c.c2);
        case "c2lDistance": return roundIds.has(c.circle) && hasLineOperand(c.line);
        case "p2cDistance": return refIds.has(c.e) && roundIds.has(c.circle);
        case "fix": return refIds.has(c.e);
        // offset: a composite over N source→copy pairs. Deleting ONE copy must
        // break only that member's link (Fusion behavior) — so SHRINK the pair
        // list the way prunePatterns shrinks sources, and drop the whole
        // constraint (with its dimension) only when nothing is left to govern.
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

  /** Drop pattern sources that reference an entity that no longer exists (e.g.
   *  Delete, or trim/fillet/offset/extend/break replacing an id) — mirrors
   *  pruneConstraints() so a vanished source can't silently shrink the pattern
   *  forever. A pattern left with zero surviving sources is dropped entirely. */
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

  /** Bank one undo step if the sketch changed since the last settled snapshot.
   *
   *  Called from requestSolve() ON PURPOSE. Every user mutation ends there —
   *  draw, trim, fillet, offset, delete, dimension, constraint, text, pattern,
   *  15+ call sites — and hand-listing them is exactly how an undo feature ends
   *  up silently missing one. The three things that must NOT be undoable are
   *  excluded structurally rather than by a denylist:
   *
   *   - The SOLVER's write-back assigns inside pump() and loops; it never calls
   *     requestSolve. So "the solver moved my geometry to satisfy a constraint"
   *     can never consume an undo step.
   *   - DERIVED updates (parameter sync, projection refresh) re-arm the baseline
   *     before calling requestSolve, so they compare equal.
   *   - DRAGS never reach here at all: queueDrag pumps directly, and endDrag
   *     banks the pre-drag snapshot as ONE step. */
  private bankIfChanged() {
    if (this.active) this.history.bankIfChanged(this.snapshot());
  }

  /** Commit a finished drag as a single undo step. The pre-drag entities were
   *  already deep-cloned into dragSnapshot for Esc-revert, so that same clone is
   *  the undo entry — a drag never touches constraints or patterns, so the
   *  current ones complete the snapshot. */
  private bankDrag() {
    const before = this.dragSnapshot;
    this.dragSnapshot = null; // committed — drop the revert buffer
    if (!before || !this.active) return;
    this.history.bankBefore(
      { entities: before, constraints: this.constraints, patterns: this.patterns },
      this.snapshot(),
    );
  }

  get canUndoSketch(): boolean { return this.history.canUndo; }
  get canRedoSketch(): boolean { return this.history.canRedo; }

  /** Undo the last edit INSIDE the sketch. Returns true when it handled the
   *  request — which is whenever a sketch is open, even with an empty stack:
   *  falling through to the document undo is precisely the old behaviour that
   *  vaporised the whole sketch. */
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
    this.filletFirst = null;
    this.splinePts = [];
    this.clickPts = [];
    this.offsetPick = null;
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
            // grabbed point is fixed and did NOT move: keep the anchor on it.
            // Advancing dragFrom to the cursor would re-run the nearest-point
            // search from a drifted origin and capture an unrelated FREE point
            // mid-gesture (yanking it to the cursor on release).
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
      // The solver's WASM never came up (seen in the field on a WebView2 that
      // refuses to compile it). Without this, the rejection escapes `void
      // this.pump()` into the global net and toasts a nameless "Something went
      // wrong" on EVERY stroke. Say what is actually unavailable, once, and
      // stop asking — the geometry is still perfectly usable unconstrained.
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
    if (e.type === "circle" || e.type === "point") return [new THREE.Vector2(e.x, e.y)];
    return [];
  }

  /** mutators for OTHER entities' endpoints that coincide with `pts` — the same
   *  position-based merge the solver does (shared coincKey, so "rides along
   *  during drag" and "merged solver point on release" agree exactly).
   *  Rectangles/circles are skipped (their shape can't follow a single corner);
   *  arcs re-solve their through-point after. */
  private stretchTargets(movedIdx: number, pts: THREE.Vector2[]): ((dx: number, dy: number) => void)[] {
    const keys = new Set(pts.map((q) => coincKey(q.x, q.y)));
    const near = (x: number, y: number) => keys.has(coincKey(x, y));
    const out: ((dx: number, dy: number) => void)[] = [];
    this.entities.forEach((e, i) => {
      if (i === movedIdx) return;
      if (e.type === "line" || e.type === "arc") {
        if (near(e.x1, e.y1)) out.push((dx, dy) => { e.x1 += dx; e.y1 += dy; });
        if (near(e.x2, e.y2)) out.push((dx, dy) => { e.x2 += dx; e.y2 += dy; });
      } else if (e.type === "spline") {
        const last = e.points.length - 1;
        for (const k of [0, last]) {
          const q = e.points[k];
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
   *  excluded — they don't expand to solver points. */
  private pickPoint(p: THREE.Vector2): { p: THREE.Vector2; idx: number } | null {
    const tol = this.pickTol();
    let best: THREE.Vector2 | null = null;
    let bestIdx = -1;
    let bestD = tol * tol;
    let cur = -1;
    const consider = (x: number, y: number) => {
      const dx = x - p.x, dy = y - p.y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = new THREE.Vector2(x, y); bestIdx = cur; }
    };
    this.entities.forEach((e, i) => {
      cur = i;
      if (e.type === "line") { consider(e.x1, e.y1); consider(e.x2, e.y2); }
      else if (e.type === "circle") consider(e.x, e.y);
      else if (e.type === "arc") { consider(e.x1, e.y1); consider(e.x2, e.y2); }
      else if (e.type === "spline") for (const q of e.points) consider(q.x, q.y);
      else if (e.type === "point") consider(e.x, e.y);
      else if (e.type === "rectangle") {
        const hw = e.width / 2, hh = e.height / 2;
        consider(e.x - hw, e.y - hh); consider(e.x + hw, e.y - hh);
        consider(e.x + hw, e.y + hh); consider(e.x - hw, e.y + hh);
      }
    });
    return best ? { p: best, idx: bestIdx } : null;
  }

  /** Queue a drag target; pump serializes solves (latest target wins). */
  private queueDrag(to: THREE.Vector2) {
    if (!this.dragFrom) return;
    this.pendingDrag = { fromX: this.dragFrom.x, fromY: this.dragFrom.y, toX: to.x, toY: to.y };
    void this.pump();
  }

  private endDrag(pointerId?: number) {
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
        // never moved: this was a click — the original (de)select behavior
        this.dragSnapshot = null;
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
    if (pointerId != null) {
      try { this.viewport.domElement.releasePointerCapture(pointerId); } catch { /* not captured */ }
    }
    if (!this.dragMoved) {
      // never moved: a click on a vertex — (de)select the owning entity, same
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
    // No transform set here: SketchPlaneGrid builds its lattice in world space
    // from the plane it is handed, because the fade is baked into vertex colours
    // and so has to know where the cursor is in the plane's own coordinates. All
    // this owns is lifetime; updateGrid() on the tick owns placement.
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
