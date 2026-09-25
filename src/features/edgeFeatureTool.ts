// Interactive Fillet / Chamfer (MCAD-style): pick a solid edge, then grab the
// drag handle on that edge and drag it to set the radius (fillet) or
// setback (chamfer), with a LIVE preview. Unlike Extrude, a fillet/chamfer
// can't be faked client-side (a real rounded/beveled edge needs build123d/OCCT),
// so the preview is engine-driven: the un-committed feature is appended to the
// tree via store.setPreview() and the normal rebuild pipeline renders it.
// Commit promotes it to a real feature (records undo); Esc clears + reverts.
//
// The gesture is a swipe away from the edge: how far the cursor is from the
// edge is the radius or the setback, and which side of it the cursor is on
// picks which of the two. features/edgeSwipe.ts does that measurement and says
// why it is made against the edge rather than along a world axis;
// features/edgeDragMath.ts turns the signed result into a treatment.
//
// So `value` here is always a magnitude and `signed` is which side of the edge
// the drag has reached, `kind` is a reading of that sign, not an independent
// piece of state, except at the origin where there is no sign to read and the
// last one stands.

import * as THREE from "three";
import { asFeature } from "../types";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import type { EdgeRef } from "../viewport/edgeLines";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore, RebuildState } from "../document/store";
import { featureValueRule } from "../document/numFields";
import type { Feature, ParamTarget, Selector } from "../types";
import { midMatchTol, polylineMid, edgeSelectorFrom } from "../viewport/edgeMatch";
import { pickScope, type PickScope } from "../viewport/pickScope";
import { canConsume } from "./toolCapabilities";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import {
  createDragHandle,
  edgeHandleAxis,
  fluentRelease,
  HANDLE_UP,
  handleScale,
  leanOutOfView,
  type DragHandle,
} from "./manipulator";
import { swipeOffsetPx } from "./edgeSwipe";
import { clearanceLimit, localClearance } from "./blendClearance";
import { fmtLength } from "../ui/units";
import { ProfileChip } from "./profileChip";
import {
  clampProfile,
  formatProfile,
  isPlainProfile,
} from "./profileArcMath";
import {
  blendRefusalReason,
  blendVerdict,
  clampValue,
  commitDecision,
  EMPTY_BLEND_RANGE,
  noteBlendOutcome,
  type BlendRange,
  dragLimit,
  MIN_EDGE_VALUE,
  otherTreatment,
  scrubSigned,
  seedValue,
  switchTreatment,
  treatmentAt,
  treatmentField,
  treatmentLabel,
  valueBounds,
  type EdgeTreatment,
  type ValueBounds,
} from "./edgeDragMath";
import { CanvasGesture } from "./canvasGesture";
import { blendEditCommit } from "./blendEdit";
import { pointOnEdge } from "./edgeNudge";
import { blendClickTarget, missPrompt, screenPolylineDist } from "./blendPick";
import { EDGE_GRAB_PX } from "../viewport/edgeBand";
import { EDGE_HOVER_COLOR } from "../viewport/highlight";
import { toast } from "../ui/toast";
import { isEditableTarget } from "../ui/focus";

type Phase = "pick" | "drag";
type Kind = EdgeTreatment;
type Vec3 = [number, number, number];

const Y_AXIS = HANDLE_UP;
// Ghost member lines (edit mode): drawn on top of the live preview, where the
// member edges themselves have been consumed into rounded faces. Colors match
// the Highlighter's SELECT / ERROR tiers so the language stays consistent.
const GHOST_SELECT = 0xff7a3c;
const GHOST_ERROR = 0xe23b3b;

/** How long a radius/distance drag has to hold still before the real engine
 *  preview is asked for. A drag tick still redraws the instant client-side
 *  ghost (viewport.setBlendGhost) every frame; this only delays the OCCT round
 *  trip, so a fast drag draws instead of queuing a rebuild per pixel moved. */
const PREVIEW_DEBOUNCE_MS = 150;

/** One member edge: its selectors, the sharp-model polyline snapshot it was
 *  matched to (for drawing + screen-space hit tests), its ghost line, and the
 *  tangent-chain gesture it arrived with (chain members select/deselect as one
 *  unit, recorded at add time because the preview may consume the edges,
 *  making the chain unrecomputable from the displayed model). */
interface GhostEdge {
  /** stable per-member id, the key the member panel removes a row by */
  id: number;
  /** Usually one. A saved feature can name the same edge twice, e.g. two
   *  points on one closed loop; both are kept so the commit writes them back. */
  sels: Selector[];
  mid: Vec3;
  points: Vec3[];
  line: Line2;
  chain: number;
  /** its colour when not hovered, select or error */
  color: number;
}

/** One row in the member panel (ui side of the ghost list). A resolved row is a
 *  member the tool could match to a real edge on screen; an unresolved one is a
 *  saved selector whose edge the current geometry no longer shows, still part of
 *  the feature and still removable, but with no line to click in the view. */
export interface EdgeMemberRow {
  key: string;
  label: string;
  resolved: boolean;
}

export class EdgeFeatureTool {
  active = false;
  private kind: Kind = "fillet";
  private phase: Phase = "pick";
  private anchor = new THREE.Vector3(); // arrow origin = edge midpoint
  // Drag axis (unit). Frozen for the duration of a GESTURE, the drag and the
  // arc both measure against it, but re-derived against the camera every idle
  // frame, so an orbit cannot leave the handle pointing at the viewer (see
  // refreshAxis).
  private axis = new THREE.Vector3(1, 0, 0);
  private quat = new THREE.Quaternion(); // Y -> axis, for orienting the handle
  private tangent: THREE.Vector3 | null = null; // edge direction (null = pre-selection fallback)
  private value = 2; // radius / distance in mm, a MAGNITUDE, never negative
  /** Position on the drag axis: |signed| is `value`, and its sign picks between
   *  `positiveKind` and its opposite. 0 means "no feature here". */
  private signed = 2;
  /** The treatment the arrow's own direction means. Fixed when the gesture
   *  opens, and swapped by Tab so the pointer never has to move to keep up. */
  private positiveKind: Kind = "fillet";
  private previewId = ""; // id shared by the live preview and the committed feature

  // --- membership (create AND edit): every selected edge is a ghost line,
  // drawn through the model (depthTest off) so inner/occluded members stay
  // visible, and click-toggleable in both modes. ---
  private ghosts: GhostEdge[] = []; // membership display + toggle targets
  private unmatchedSels: Selector[] = []; // saved selectors we couldn't visualize (kept for commit)

  // --- edit mode (re-opening a committed fillet/chamfer) ---
  private editId: string | null = null; // committed feature id being edited
  private awaitingRollback = false; // waiting for the rolled-back model build
  private unsubBuild: (() => void) | null = null;
  /** Set when the edited field is a bare reference to this OTHER parameter
   *  (store.bareParamRef): the handle stays live, but commit writes the drag's
   *  value into this parameter instead of the field, which stays bound to it. */
  private paramRef: string | null = null;
  /** The feature as committed, and what buildFeature() made of it the moment
   *  the edit opened. Commit takes from the tool only what differs from
   *  `opened`, see features/blendEdit.ts. */
  private original: Feature | null = null;
  private opened: Feature | null = null;

  private gizmo: THREE.Group | null = null;
  private handle: DragHandle | null = null;
  /** Fillet only: a chamfer's section IS the chord, so a profile has nothing
   *  to say about it. */
  private chip: ProfileChip | null = null;
  /** Section shape in (-1, 1); 0 is the plain circular fillet. Survives a Tab to
   *  chamfer and back, so flipping to compare does not silently discard it. */
  private profile = 0;
  /** Options the drag does not set, kept from the feature being edited so a
   *  re-edit does not quietly reset them. */
  private options: Record<string, unknown> = {};
  private optionsKind: Kind | null = null;
  private continuity: "G1" | "G2" = "G1";
  private hovering = false;
  private grabbing = false;
  /** true when this drag began on the passive selection handle rather than on
   *  our own gizmo, a one-press gesture, so releasing it commits (see onUp). */
  private fluentGrab = false;
  private grabSigned = 0; // signed offset at grab start (relative drag)
  private grabProj = 0; // axis projection at grab start
  private downPos = { x: 0, y: 0 };
  private downOnGizmo = false;
  /** pending debounced engine preview, see schedulePreviewDuringDrag */
  private previewTimer: number | null = null;

  private dim = new DimInput();
  private onDone: ((id: string | null) => void) | null = null;

  private readonly gesture: CanvasGesture;

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
  ) {
    this.gesture = new CanvasGesture(viewport.domElement, {
      move: (e) => this.onMove(e),
      down: (e) => this.onDown(e),
      up: (e) => this.onUp(e),
      key: (e) => this.onKey(e),
      frame: () => this.tick(),
    });
  }

  private get field() {
    return treatmentField(this.kind);
  }

  /** The model's bounding-box diagonal, or null before there is any geometry.
   *  Read per use rather than cached: it moves with every rebuild, and the
   *  preview rebuilds all through the drag. */
  private modelDiagonal(): number | null {
    const bb = this.store.buildState.result?.bbox;
    if (!bb) return null;
    return Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
  }

  /** The largest blend the picked edges' own surroundings permit, measured once
   *  per member set and held, the OPPOSITE of modelDiagonal's policy, and for a
   *  reason that would otherwise be a nasty bug.
   *
   *  The measurement has to describe the model the blend is applied TO. Once the
   *  drag starts, the displayed model is the preview: the blend is already in it,
   *  and its new faces sit right where the clearance is being measured. Re-read
   *  per frame, the bound would shrink as the value grew, chase it down and pin
   *  the drag somewhere short of where it could have gone. So it is taken from
   *  the geometry as it stands when the membership settles, and left alone. */
  private clearanceLimitMm: number | null = null;

  private measureClearance() {
    const all = this.viewport.visibleEdgeLines().map((e) => ({ id: e.id, points: e.points }));
    // The picked edges are identified by their own geometry rather than matched
    // back to model edge ids, which the preview renumbers. Nothing is lost: an
    // edge measures 0 from itself and from the chain-mates it shares vertices
    // with, and localClearance already discards everything inside the touch
    // tolerance as attached rather than nearby.
    const selected = this.ghosts.map((g, i) => ({ id: `pick:${i}`, points: g.points }));
    this.clearanceLimitMm = clearanceLimit(
      localClearance({ selected, all, modelScale: this.modelDiagonal() ?? 0 }),
    );
  }

  /** How far the cursor is from the picked edge, in mm, signed by which side of
   *  it the cursor is on, the whole of the drag measurement (features/edgeSwipe.ts
   *  has the reasoning and the arithmetic).
   *
   *  Both reference directions are taken by projecting a step along them from
   *  the anchor rather than by any screen-space shortcut, so the measurement
   *  follows the same camera the handle is drawn under, frame for frame. The
   *  step is 40px worth of world at the anchor, which is long enough that the
   *  projection's own rounding is nothing beside it and short enough that a
   *  perspective camera has not bent it. */
  private swipeProj(clientX: number, clientY: number): number {
    const px = this.viewport.pixelWorldSize(this.anchor);
    const step = px * 40;
    const o = this.viewport.projectToScreen(this.anchor);
    const along = (v: THREE.Vector3) => {
      const p = this.viewport.projectToScreen(this.anchor.clone().addScaledVector(v, step));
      return { x: p.x - o.x, y: p.y - o.y };
    };
    // No tangent means a multi-edge pre-selection with no single direction to
    // be perpendicular to; edgeSwipe falls back to travel along the arrow,
    // which is the best available answer and the one the axis gave before.
    const edgeDir = this.tangent ? along(this.tangent) : { x: 0, y: 0 };
    return swipeOffsetPx(o, edgeDir, along(this.axis), { x: clientX, y: clientY }) * px;
  }

  /** The largest size the engine has built during this gesture, and the
   *  smallest it has refused, see blendVerdict.
   *
   *  Reset whenever the question changes: a different treatment, profile or set
   *  of member edges is a different question, and carrying an answer across
   *  would refuse the new one at the old one's limit. */
  private range: BlendRange = EMPTY_BLEND_RANGE;
  /** What the kernel said the last time it refused this question. */
  private refusal: { code: string | null; message: string } | null = null;
  /** The size the model on screen was built at for this question, null when it
   *  shows no blend of ours. A refused size keeps the previous one on screen
   *  (store.setPreview's hold), so this is what a refused release commits. */
  private shown: number | null = null;
  /** the refusal currently painted on the handle, box and prompt */
  private refusalShown: string | null = null;

  private forgetBuildRange() {
    this.range = EMPTY_BLEND_RANGE;
    this.refusal = null;
    this.shown = null;
  }

  /** How far the drag may travel either side of the origin. */
  private limit(): number {
    return dragLimit(this.modelDiagonal());
  }

  /** The value as the feature stores it, which is what replies are matched on. */
  private size(): number {
    return Math.round(this.value * 1000) / 1000;
  }

  /** Everything about the previewed feature except its size and id. */
  private questionOf(f: Feature): string {
    const rest: Record<string, unknown> = { ...f };
    delete rest.id;
    delete rest.radius;
    delete rest.distance;
    delete rest.draft;
    return JSON.stringify(rest);
  }

  private sizeOf(f: Feature): number | null {
    const v = f.type === "fillet" ? f.radius : f.type === "chamfer" ? f.distance : null;
    return typeof v === "number" ? v : null;
  }

  private get refusedNow(): boolean {
    return !this.neutral
      && this.currentSelectors().length > 0
      && blendVerdict(this.range, this.size()) === "refused";
  }

  /** Paint the refusal, or take it down, on the handle, the value box and the
   *  prompt. Cheap enough to run on every change of value. */
  private refreshRefusal() {
    const reason = this.refusedNow && this.refusal
      ? blendRefusalReason(this.kind, this.memberCount(), this.refusal)
      : null;
    if (reason === this.refusalShown) return;
    this.refusalShown = reason;
    if (reason === null) this.recolorGhostsFromDiagnostics(undefined);
    this.dim.showOwnProblem(reason);
    this.handle?.paint({ refused: reason !== null });
    this.viewport.requestRender();
    this.promptForPhase();
  }

  private bounds(): ValueBounds {
    return valueBounds(this.modelDiagonal());
  }

  /** `opts` is the direct-manipulation entry (features/edgeNudge.ts): the user
   *  pressed on the handle that appears the moment an edge is selected, so we
   *  arm from that pre-selection AND begin scrubbing inside the same
   *  pointerdown. `tangent` is the handle's, adopted rather than recomputed so
   *  the handle does not jump at the instant of the grab. */
  start(
    kind: Kind,
    onDone: (id: string | null) => void,
    opts?: { tangent?: THREE.Vector3 | null; grabAt?: { x: number; y: number }; anchor?: THREE.Vector3 },
  ) {
    if (this.active) return;
    // The direct-manipulation entry needs the selection its handle was drawn
    // for. If a rebuild landed between the paint and the press, arming into the
    // pick phase would be a bait-and-switch into a tool nobody asked for, and
    // it would hold toolBusy() until noticed. Refuse before anything is
    // installed rather than arm and unwind.
    const pre = this.viewport.selectedEdgeSelectors();
    if (opts?.grabAt && !pre.length) return;
    // The OTHER way in: a selected FACE, which stands for every edge around it.
    // toolCapabilities.ts is what says a face is a kind this tool can consume,
    // so the table and the behaviour cannot drift apart, and asking here rather
    // than in each caller means the face route exists from the key, the ribbon,
    // the palette and the context menus at once.
    const seed = pre.length
      ? pre
      : canConsume(kind, "face")
        ? this.faceEdgeSelectors()
        : [];
    this.active = true;
    this.kind = kind;
    this.phase = "pick";
    this.onDone = onDone;
    this.tangent = null;
    this.viewport.suspendPicking = true; // we drive our own edge-only picking
    this.viewport.emphasizeEdges(true); // light up all edges so they're easy to target
    this.gesture.attach();

    // pre-selection (Ctrl/Shift-click, a selected face, or the selection
    // handle): skip the pick phase and go straight to the drag
    if (seed.length) {
      // Grabbing the handle opens at 0, so the drag distance IS the radius and
      // the point you pressed is the point you can come back to for "no
      // feature". Arriving from a command instead has nothing to measure yet,
      // so it opens on the default and shows a preview immediately.
      // The handle's own anchor when it has one: it may stand where the edge was
      // clicked, and the tool taking over must not move it.
      this.beginDrag(seed, opts?.anchor?.clone() ?? this.anchorFromSelectors(seed), opts?.tangent ?? null, undefined, {
        fromZero: !!opts?.grabAt,
        // A face's edges are already the complete, closed set the user asked
        // for: expanding each across its tangent chain could only reach edges
        // that are NOT on the face, which is the one thing "round off this face"
        // rules out. An EDGE pre-selection carries whatever its own picks
        // decided (pickScope.ts), shift-picked edges stay exactly themselves.
        scope: pre.length ? this.viewport.selectedEdgeScope().scope : "single",
      });
      if (opts?.grabAt) this.grabHandle(opts.grabAt.x, opts.grabAt.y);
    } else {
      setPrompt(`Click an edge to ${kind} · Ctrl-click a chain · Shift-click one · or pick a face`);
    }
  }

  /** Selectors for every edge around the SELECTED faces, or [] when no face is
   *  selected. Which edges those are is viewport/faceEdges.ts (geometry, because
   *  the rebuild reply carries no face→edge topology); this is only the
   *  translation into the selectors a fillet stores. */
  private faceEdgeSelectors(): Selector[] {
    return this.viewport.edgesOfSelectedFaces().flatMap((line): Selector[] => {
      const sel = edgeSelectorFrom({ points: line.points, body: line.body });
      return sel ? [sel] : [];
    });
  }

  /** Take hold of the handle at (x, y) without a fresh pointerdown of our own,
   *  the press that started the gesture landed on the passive selection handle,
   *  before this tool existed. Everything after this point is the ordinary
   *  drag: the same onMove scrub, the same onUp release. */
  private grabHandle(clientX: number, clientY: number) {
    if (this.phase !== "drag") return;
    this.grabbing = true;
    this.fluentGrab = true;
    this.downOnGizmo = true;
    this.downPos = { x: clientX, y: clientY };
    this.grabSigned = this.signed;
    this.grabProj = this.swipeProj(clientX, clientY);
    this.viewport.domElement.style.cursor = "grabbing";
  }

  /** Re-open a committed fillet/chamfer for editing: the model rolls back to
   *  just before the feature (its member edges exist again), the saved edges
   *  show as orange ghost lines (click one to remove it, click any other edge
   *  to add it), the saved value seeds the input, and commit writes back only what
   *  changed (same id, name and binding, one undo step). Returns false when this
   *  feature can't be tool-edited (parameter-driven value, or selectors
   *  without a point), the caller falls back to the value rows. */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const raw = this.store.document.features.find((x) => x.id === featureId);
    const f = asFeature(raw, "fillet") ?? asFeature(raw, "chamfer");
    if (!f) return false;
    const value = f.type === "fillet" ? f.radius : f.distance;
    const field = f.type === "fillet" ? "radius" : "distance";
    if (typeof value !== "number") return false;
    const target: ParamTarget = { kind: "feature", feature: f.id, field };
    const bareRef = this.store.bareParamRef(target);
    // A real expression (not just a bare reference) stays refused: a drag
    // writes a plain number, which is exactly what a "wall_blend_r * 2" is not.
    if (this.store.isParamBound(target) && !bareRef) return false;
    const sels = Array.isArray(f.edges) ? f.edges : [f.edges];
    if (!sels.length || !sels.every((s) => "point" in s)) return false; // structural selectors, can't re-anchor

    this.active = true;
    this.kind = f.type;
    this.phase = "drag";
    this.onDone = onDone;
    this.tangent = null;
    this.editId = featureId;
    this.paramRef = bareRef;
    this.original = structuredClone(f) as Feature;
    this.opened = null;
    this.previewId = featureId; // keep the SAME id through preview and commit
    this.positiveKind = f.type; // the saved treatment keeps the arrow's own side
    this.value = value;
    this.signed = value;
    this.profile =
      f.type === "fillet" && typeof f.profile === "number" ? clampProfile(f.profile) : 0;
    this.continuity = f.type === "fillet" && f.continuity === "G2" ? "G2" : "G1";
    this.options = f.type === "fillet"
      ? { sizeType: f.sizeType, tangentEdges: f.tangentEdges }
      : { chamferType: f.chamferType, distance2: f.distance2, tangentEdges: f.tangentEdges };
    this.optionsKind = f.type;
    this.unmatchedSels = [];
    this.awaitingRollback = true;

    this.viewport.suspendPicking = true;
    this.viewport.emphasizeEdges(true); // additions should be easy to see
    this.gesture.attach();
    setPrompt("Rolling back to edit…");

    // Roll the model to just before the feature; the NEXT completed build shows
    // the sharp member edges, which we snapshot as ghosts before pushing the
    // live preview back on top of them.
    this.store.beginEditPreview(featureId);
    this.watchBuilds(sels);
    return true;
  }

  /** Watch completed rebuilds for the whole gesture.
   *
   *  Edit mode also uses the FIRST one to snapshot the rolled-back sharp edges
   *  (pass its saved selectors); create mode passes null and only wants the
   *  kernel's verdicts. */
  private watchBuilds(rollbackSels: Selector[] | null) {
    this.unsubBuild = this.store.onBuild((s) => {
      if (s.building || !s.result) return;
      if (this.awaitingRollback && rollbackSels) {
        // A build already in flight when the edit opened lands first, and it is
        // the full model, where the blend has already consumed its own edges.
        if (!s.previewBuilt) return;
        this.awaitingRollback = false;
        this.seedGhosts(rollbackSels);
        this.opened = this.buildFeature();
        this.enterEditUI();
        this.refreshGhost();
        this.pushPreview();
        return;
      }
      if (this.phase !== "drag") return;
      this.noteBuildOutcome(s);
      this.refreshRefusal();
    });
  }

  /** Record what the kernel said about the size it was SENT, which during a fast
   *  drag is often not the size on the handle any more. A reply for an earlier
   *  question (other treatment, edges or profile) says nothing about this one. */
  private noteBuildOutcome(s: RebuildState) {
    const sent = s.previewBuilt?.find((f) => f.id === this.previewId) ?? null;
    const held = s.heldRefusal?.featureId === this.previewId ? s.heldRefusal : null;
    const current = sent !== null && this.questionOf(sent) === this.questionOf(this.buildFeature());
    const size = sent ? this.sizeOf(sent) : null;
    if (!held) this.shown = current ? size : null;
    if (current && size !== null) {
      this.range = noteBlendOutcome(this.range, size, !held);
      if (held) this.refusal = { code: held.code, message: held.message };
    }
    if (current) this.recolorGhostsFromDiagnostics(held?.diagnostics);
    // The ghost's job ends the moment the real geometry for THIS size is on
    // screen. A held refusal swaps it for the capped one instead. A reply for
    // an older size mid-debounce is `current` too (questionOf ignores the
    // size itself) but doesn't match `this.size()`, so the ghost stays up.
    if (current && held) this.refreshGhost();
    else if (current && size !== null && Math.abs(size - this.size()) < 1e-9) {
      this.viewport.clearBlendGhost();
    }
  }

  /** Match each saved selector to a rendered sharp edge and build its ghost.
   *  Selectors that don't match are kept for commit but have no visual, the
   *  engine still resolves them by nearest at build time. */
  private seedGhosts(sels: Selector[]) {
    for (const sel of sels) {
      if (!("point" in sel)) {
        this.unmatchedSels.push(sel);
        continue;
      }
      const line = this.viewport.edgeLineForSelector(sel.point as Vec3, sel.body);
      const same = line && this.ghosts.find((g) => g.points === line.points);
      if (same) same.sels.push(sel);
      else if (line) this.addGhost(sel, line.points as Vec3[]);
      else this.unmatchedSels.push(sel);
    }
  }

  private chainCounter = 0; // one id per add gesture (chain toggles as a unit)
  private memberSeq = 0; // one id per member, stable for the panel's row keys

  private addGhost(sel: Selector, points: Vec3[], chain?: number) {
    const mid = polylineMid(points);
    if (!mid) return; // an edge always has points; nothing to ghost otherwise
    const geo = new LineGeometry();
    const flat: number[] = [];
    for (const p of points) flat.push(p[0], p[1], p[2]);
    geo.setPositions(flat);
    const el = this.viewport.domElement;
    const mat = new LineMaterial({
      color: GHOST_SELECT,
      linewidth: 3.5,
      worldUnits: false,
      depthTest: false,
      transparent: true,
    });
    mat.resolution.set(el.clientWidth, el.clientHeight);
    const line = new Line2(geo, mat);
    line.renderOrder = 998;
    this.viewport.addToScene(line);
    this.ghosts.push({ id: ++this.memberSeq, sels: [sel], mid, points, line, chain: chain ?? ++this.chainCounter, color: GHOST_SELECT });
  }

  // --- member panel (ui/FilletMembers.vue) ----------------------------------
  //
  // The same ghost list, read as rows and edited by row key rather than by a
  // click in the view: what the request wants for a blend with a lot of member
  // edges, and the only way to reach the unresolved ones, which have no line.

  /** True while a blend is being sized, so its members are settled enough to
   *  list. The pick phase (no members yet) shows nothing. */
  editingMembers(): boolean {
    return this.active && this.phase === "drag";
  }

  /** Which blend the panel is titling, fillet or chamfer. Follows a Tab flip. */
  blendKind(): "fillet" | "chamfer" {
    return this.kind;
  }

  /** The member rows: every matched edge, then every unresolved saved
   *  selector, in that order. Read fresh each poll, so it follows adds and
   *  removes made in the viewport as well as from the panel. */
  memberRows(): EdgeMemberRow[] {
    const rows: EdgeMemberRow[] = this.ghosts.map((g, i) => ({
      key: `m${g.id}`,
      label: `Edge ${i + 1}`,
      resolved: true,
    }));
    this.unmatchedSels.forEach((_, i) => {
      rows.push({ key: `u${i}`, label: "Unresolved edge", resolved: false });
    });
    return rows;
  }

  /** Drop a member the panel names. A resolved row takes its whole tangent
   *  chain with it, exactly as clicking its line does, because a blend cannot
   *  terminate mid-tangency; an unresolved row removes only itself. */
  removeMemberByKey(key: string) {
    if (this.phase !== "drag") return;
    if (key.startsWith("m")) {
      const id = Number(key.slice(1));
      const g = this.ghosts.find((x) => x.id === id);
      if (!g) return;
      this.removeWithChain(g);
    } else if (key.startsWith("u")) {
      const i = Number(key.slice(1));
      if (i < 0 || i >= this.unmatchedSels.length) return;
      this.unmatchedSels.splice(i, 1);
    } else {
      return;
    }
    this.afterMembershipChange();
  }

  /** The panel's "add" affordance: adding is already a click on an edge in the
   *  view (edges are emphasized for the whole gesture), so this only says so. */
  promptAddMember() {
    if (this.phase !== "drag") return;
    setPrompt(`Click an edge in the view to add it to the ${this.kind}`);
  }

  private removeGhost(g: GhostEdge) {
    if (g === this.hoveredGhost) this.hoveredGhost = null;
    this.ghosts = this.ghosts.filter((x) => x !== g);
    this.viewport.removeFromScene(g.line);
    g.line.geometry.dispose();
    (g.line.material as LineMaterial).dispose();
  }

  private disposeGhosts() {
    for (const g of [...this.ghosts]) this.removeGhost(g);
    this.unmatchedSels = [];
  }

  /** The member ghost nearest the pointer and its screen distance, within the
   *  same grab radius as a model edge. Measured against the projected polyline
   *  (Line2 raycast is finicky with tool-owned materials), along its segments
   *  and not only at its points, which on a straight edge are its two ends. */
  private ghostAt(clientX: number, clientY: number): { g: GhostEdge; dist: number } | null {
    let best: { g: GhostEdge; dist: number } | null = null;
    for (const g of this.ghosts) {
      const pts = g.points.map((p) => this.viewport.projectToScreen(new THREE.Vector3(p[0], p[1], p[2])));
      const dist = screenPolylineDist(pts, { x: clientX, y: clientY });
      if (dist <= EDGE_GRAB_PX && (!best || dist < best.dist)) best = { g, dist };
    }
    return best;
  }

  /** What the pointer is on in the drag phase: a member to drop, an edge to
   *  add, or nothing. */
  private clickTarget(clientX: number, clientY: number):
    | { kind: "member"; g: GhostEdge }
    | { kind: "edge"; hit: NonNullable<ReturnType<Viewport["pickEdgeAt"]>> }
    | null {
    const ghost = this.ghostAt(clientX, clientY);
    const hit = this.viewport.pickEdgeAt(clientX, clientY);
    const t = blendClickTarget(ghost?.dist ?? null, hit?.rankPx ?? null, EDGE_GRAB_PX);
    if (t === "member" && ghost) return { kind: "member", g: ghost.g };
    if (t === "edge" && hit) return { kind: "edge", hit };
    return null;
  }

  private hoveredGhost: GhostEdge | null = null;

  /** The edge a click would add, tinted and drawn again wide on top, since the
   *  tint alone is hard to tell from the other lit edges. */
  private hoverModelEdge(edge: EdgeRef | null) {
    this.viewport.hoverEdge(edge);
    this.viewport.emphasiseEdge(edge);
  }

  /** Light the member a click would drop, the way a model edge lights up
   *  before a click adds it. */
  private hoverGhost(g: GhostEdge | null) {
    if (g === this.hoveredGhost) return;
    const prev = this.hoveredGhost;
    this.hoveredGhost = g;
    if (prev && this.ghosts.includes(prev)) (prev.line.material as LineMaterial).color.set(prev.color);
    if (g) (g.line.material as LineMaterial).color.set(EDGE_HOVER_COLOR);
    this.viewport.requestRender();
  }

  // --- tangent-chain propagation (MCAD "G1 chain") --------------------------
  // A fillet/chamfer cannot terminate mid-tangency: an edge that blends
  // smoothly into a neighbour (e.g. a straight rim stretch meeting a rounded
  // corner arc) drags that neighbour into the operation, OCCT has no way to
  // end the blend at their joint. So every pick expands across
  // tangent-continuous connections, and deselection removes the same chain.

  /** All model edges tangent-connected to `start` (including `start`), walked
   *  breadth-first across shared endpoints whose end-tangents are colinear. */
  private tangentChain(start: EdgeRef): EdgeRef[] {
    const all = this.viewport.visibleEdgeLines();
    const bb = this.store.buildState.result?.bbox;
    const diag = bb
      ? Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2])
      : 100;
    const joinTol = Math.max(1e-4, 1e-5 * diag); // endpoint coincidence
    const G1_COS = Math.cos((10 * Math.PI) / 180); // tangents within 10°

    type End = { p: Vec3; t: THREE.Vector3 }; // endpoint + unit tangent there
    const endsOf = (l: EdgeRef): End[] => {
      const pts = l.points as Vec3[];
      const first = pts[0];
      const second = pts[1];
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      if (!first || !second || !last || !prev) return [];
      const tHead = new THREE.Vector3(
        second[0] - first[0], second[1] - first[1], second[2] - first[2]).normalize();
      const tTail = new THREE.Vector3(
        last[0] - prev[0], last[1] - prev[1], last[2] - prev[2]).normalize();
      return [{ p: first, t: tHead }, { p: last, t: tTail }];
    };

    const chain = new Set<EdgeRef>([start]);
    const queue: EdgeRef[] = [start];
    while (queue.length) {
      const cur = queue.pop();
      if (!cur) break;
      for (const ce of endsOf(cur)) {
        for (const cand of all) {
          if (chain.has(cand)) continue;
          for (const oe of endsOf(cand)) {
            const d = Math.hypot(ce.p[0] - oe.p[0], ce.p[1] - oe.p[1], ce.p[2] - oe.p[2]);
            if (d > joinTol) continue;
            if (Math.abs(ce.t.dot(oe.t)) < G1_COS) continue;
            chain.add(cand);
            queue.push(cand);
            break;
          }
        }
      }
    }
    return [...chain];
  }

  /** Add a picked edge as ghosts (skipping already-ghosted), taking its whole
   *  tangent chain along or not according to `scope`, see viewport/pickScope.ts
   *  for who decides that and why. The whole gesture shares one chain id either
   *  way, so it deselects as one unit and a single-scoped pick removes exactly
   *  the one edge it added. */
  private addPicked(line: EdgeRef, scope: PickScope) {
    const chainId = ++this.chainCounter;
    for (const l of scope === "single" ? [line] : this.tangentChain(line)) {
      const pts = l.points as Vec3[];
      const sel = edgeSelectorFrom({ points: pts, body: l.body });
      if (!sel) continue;
      const mid = sel.point;
      if (this.ghosts.some((g) => Math.hypot(g.mid[0] - mid[0], g.mid[1] - mid[1], g.mid[2] - mid[2]) < 1e-6)) continue;
      this.addGhost(sel, pts, chainId);
    }
  }

  /** What a pick INSIDE the armed tool means. Same rule as the picks that armed
   *  it (viewport/pickScope.ts): shift for exactly this edge, otherwise the
   *  camera decides, so adding a member mid-gesture behaves the way adding one
   *  before the gesture did. */
  private scopeFor(e: PointerEvent, edge: EdgeRef): PickScope {
    return pickScope({ shift: e.shiftKey, view: this.viewport.edgeScopeView(edge) }).scope;
  }

  /** Remove a ghost AND everything added in the same gesture (its chain id),
   *  recorded at add time, so removal works even after the live preview has
   *  consumed the chain's edges in the displayed model. */
  private removeWithChain(g: GhostEdge) {
    for (const ghost of [...this.ghosts]) {
      if (ghost.chain === g.chain) this.removeGhost(ghost);
    }
  }

  /** Mount the drag-phase UI (gizmo + value input) anchored to the current
   *  member set, seeded with the saved value. */
  private enterEditUI() {
    this.placeOnMembers();
    this.axis.copy(this.computeAxis());
    this.quat.setFromUnitVectors(Y_AXIS, this.axis);
    // Reached only once the rollback build has landed, so the displayed model is
    // the one WITHOUT this feature, which is exactly the geometry the blend has
    // to fit into, and the reason editing measures the same way creating does.
    this.measureClearance();
    this.buildGizmo();
    this.mountInput();
    this.promptForPhase();
    this.gesture.frame();
  }

  /** (Re)build the heads-up input for the CURRENT treatment. DimInput builds
   *  its fields once in show() (and tears down whatever was there first), so
   *  switching which field is displayed means putting the whole box back,
   *  which happens on every Tab and on every crossing of the origin, hence one
   *  place to do it. `keepTyped` locks the value in as the user's own rather
   *  than letting the drag track over it. */
  private mountInput(keepTyped = false) {
    this.chip?.dispose();
    this.chip =
      this.kind === "fillet"
        ? new ProfileChip(this.profile, (p) => {
            this.profile = p;
            this.forgetBuildRange(); // a conic section has its own limit
            this.pushPreview();
            this.promptForPhase();
          })
        : null;
    // The label names the bound parameter, not just the field, so dragging
    // doesn't look like an ordinary literal edit it silently isn't.
    const field = this.paramRef ? { ...this.field, label: `${this.field.label}·${this.paramRef}` } : this.field;
    this.dim.show([{ ...field, kind: "length", ...featureValueRule(this.kind, this.field.name) }], () => this.commit(), () => this.cancel(),
      this.kind === "fillet"
        ? {
            label: this.continuity,
            title: "Continuity: G1 is a circular round, G2 eases into the faces with no jump in curvature. Click to switch",
            initial: this.continuity === "G2",
            onChange: (on) => {
              this.continuity = on ? "G2" : "G1";
              this.dim.setToggleLabel(this.continuity);
              this.forgetBuildRange(); // G2 sets back further, so its limit is not G1's
              this.pushPreview();
            },
          }
        : undefined,
      this.chip?.el);
    this.dim.showOwnProblem(this.refusalShown);
    if (keepTyped) this.dim.seed(this.field.name, this.value);
    else this.dim.updateFromCursor({ [this.field.name]: this.value });
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
  }

  /** Adopt a magnitude on the side of the origin the CURRENT treatment sits on,
   *  keeping `signed` in step so the next grab picks up where this left off. */
  private setValue(v: number) {
    this.value = v;
    this.signed = (this.kind === this.positiveKind ? 1 : -1) * v;
  }

  /** True when switching to `k` would silently drop a parameter expression: the
   *  committed feature's field for that treatment is bound, and commit writes a
   *  plain number. startEdit refuses to open such a value at all; this is the
   *  same refusal for the field the user is about to switch INTO. */
  private paramBlocked(k: Kind): boolean {
    if (!this.editId) return false;
    // The CURRENT field is a bare parameter reference: flipping would need a
    // field that parameter isn't bound to, so it stays off for this edit too.
    if (this.paramRef) return true;
    return this.store.isParamBound({
      kind: "feature",
      feature: this.editId,
      field: treatmentField(k).name,
    });
  }

  /** The full member selector set (ghosted + unmatched saved selectors). */
  private currentSelectors(): Selector[] {
    return [...this.unmatchedSels, ...this.ghosts.flatMap((g) => g.sels)];
  }

  /** Distinct member edges, what the prompt counts: two selectors on one edge
   *  are one edge. */
  private memberCount(): number {
    return this.unmatchedSels.length + this.ghosts.length;
  }

  /** Fillet ↔ chamfer without moving the pointer, what Tab does.
   *
   *  The drag already switches treatments by crossing the origin, but that only
   *  helps someone whose hand is on the handle: a typed value has no side of the
   *  origin, and a value reached by dragging shouldn't have to be dragged back
   *  through zero and out again just to be re-labelled. So this flips the
   *  treatment in place AND flips which side of the axis means it, otherwise
   *  the next pointermove would read the unchanged sign and undo the flip. */
  private flipKind() {
    if (this.phase !== "drag") return;
    const prevName = this.field.name;
    const typed = this.dim.isUserDriven(prevName);
    if (typed) {
      const v = this.dim.getValue(prevName);
      if (v != null) this.value = v; // a typed number is preferred over the drag's
    }
    // A typed number is the user's, not the drag's: hold it to the absolute
    // floor only. Re-clamping it to the DRAG bounds would round a deliberate
    // 0.2 mm up to whatever the current zoom's snap step happens to be.
    const bounds = typed ? { min: MIN_EDGE_VALUE, max: Infinity } : this.bounds();
    const next = switchTreatment(this.kind, this.value, bounds);
    if (this.paramBlocked(next.kind)) {
      setPrompt(`This feature's ${treatmentField(next.kind).name} is driven by a parameter, change it in the history`);
      return;
    }
    this.kind = next.kind;
    this.positiveKind = otherTreatment(this.positiveKind);
    this.forgetBuildRange(); // a chamfer's limit is not a fillet's
    // At the origin there is nothing to re-label but the treatment itself:
    // switchTreatment's clamp would otherwise conjure a 0.001 mm feature out of
    // a gesture deliberately sitting on "none".
    this.setValue(this.value < MIN_EDGE_VALUE ? 0 : next.value);
    this.mountInput(typed);
    this.refreshGhost(); // the ghost's SHAPE flips fillet <-> chamfer here too
    this.pushPreview();
    this.promptForPhase();
  }

  /** True when the gesture is sitting on the origin: no treatment, no preview,
   *  and nothing to commit. */
  private get neutral() {
    return this.value < MIN_EDGE_VALUE;
  }

  /** The drag-phase prompt.
   *
   *  One function because five things move under it, the treatment, the member
   *  count, create-vs-edit, sitting on the origin, and whether the kernel is
   *  currently refusing the value, and the three hand-written copies this
   *  replaced had already drifted apart on which keys they bothered to
   *  mention. */
  private promptForPhase() {
    const n = this.memberCount();
    if (!n) {
      setPrompt("Click an edge · Esc");
      return;
    }
    if (this.neutral) {
      setPrompt(`Drag out for a ${this.positiveKind}, back for a ${otherTreatment(this.positiveKind)} · release to cancel`);
      return;
    }
    if (this.refusalShown) {
      const then = this.dim.isUserDriven(this.field.name)
        ? `type a smaller ${this.field.name}`
        : this.shown !== null
          ? `keeping ${fmtLength(this.shown)}`
          : "drag smaller";
      setPrompt(`${this.refusalShown} · ${then} · Esc`);
      return;
    }
    // The profile only earns a mention on a fillet, and only says its number
    // once it is off the circular default, otherwise it is noise on the one
    // line the user reads mid-drag.
    const prof =
      this.kind === "fillet" && !isPlainProfile(this.profile)
        ? ` · profile ${formatProfile(this.profile)}`
        : "";
    const param = this.paramRef ? ` · sets parameter "${this.paramRef}"` : "";
    setPrompt(
      `${treatmentLabel(this.kind)}, ${n} edge${n === 1 ? "" : "s"} · drag or type a ${this.field.name}${prof}${param} · Tab · Enter · Esc`,
    );
  }

  /** Route the live preview to the right store channel: edit mode replaces the
   *  committed feature at its timeline position; create mode appends.
   *
   *  Nothing to preview covers two states that look different to the user and
   *  identical to the kernel: no member edges, and a drag parked on the origin.
   *  Either way the feature we would build is one OCCT would refuse (a
   *  zero-radius blend, a fillet over no edges), and it would refuse it again on
   *  every pointermove, so the preview drops back to the bare model, which is
   *  also exactly what "no feature here" should look like. */
  private pushPreview() {
    if (this.neutral || !this.currentSelectors().length) {
      if (this.editId) this.store.setEditPreview(null);
      else this.store.setPreview(null);
      this.shown = null;
      this.refreshRefusal();
      return;
    }
    // A size already refused is not asked again: the kernel would only say no
    // once more, and the model keeps the last size that built meanwhile.
    if (blendVerdict(this.range, this.size()) !== "refused") {
      // A draft builds quicker and coarser during the drag; commit builds the real one.
      const feature = { ...this.buildFeature(), draft: true } as Feature;
      if (this.editId) this.store.setEditPreview(feature, { hold: true });
      else this.store.setPreview(feature, { hold: true });
    }
    this.refreshRefusal();
  }

  /** Instant client-side approximation of the current blend, redrawn every
   *  drag tick from the picked edges' own polylines and the mesh's real
   *  face normals around them (features/blendGhost.ts has the geometry,
   *  viewport/ghosts.ts derives the normals). Cleared under the same
   *  conditions pushPreview drops back to the bare model. Replaced by the
   *  exact preview mesh the moment a matching reply lands, see
   *  noteBuildOutcome, which is what makes this safe to leave slightly wrong
   *  (an approximate arc, no profile, no clearance check) rather than exact. */
  private refreshGhost() {
    if (this.neutral || !this.ghosts.length) {
      this.viewport.clearBlendGhost();
      return;
    }
    // A size the kernel already refused is never drawn: the ghost would show a
    // round the faces cannot hold. It stops, in red, at the size kept on screen.
    const capped = this.refusedNow;
    const size = capped ? this.shown : this.size();
    if (size == null) {
      this.viewport.clearBlendGhost();
      return;
    }
    this.viewport.setBlendGhost(
      this.ghosts.map((g) => ({ body: g.sels[0]?.body, points: g.points })),
      size,
      this.kind,
      capped,
    );
  }

  /** A drag tick or a scrubbed numeric field: the ghost updates now (see
   *  refreshGhost), but the real engine round trip waits until the size holds
   *  still for PREVIEW_DEBOUNCE_MS, or flushPreviewNow forces it (release, a
   *  commit). Discrete actions (Tab, adding/removing a member) call
   *  pushPreview directly, they don't repeat fast enough to need this. */
  private schedulePreviewDuringDrag() {
    this.refreshGhost();
    if (this.previewTimer != null) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      this.pushPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  /** Ask the engine right away, dropping any pending debounce. A no-op when
   *  nothing is pending, so it's safe to call on every release. */
  private flushPreviewNow() {
    if (this.previewTimer == null) return;
    window.clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.pushPreview();
  }

  /** Paint ghosts red when the engine's failure probe names their edge (the
   *  edgeOpFailed diagnostic carries the failed edges' midpoints). */
  private recolorGhostsFromDiagnostics(diags: import("../types").ResolveDiag[] | undefined) {
    const entry = diags?.find(
      (d) => d.kind === "edgeOpFailed" && d.feature_id === this.previewId && d.failed?.length,
    );
    const bb = this.store.buildState.result?.bbox;
    const diag = bb
      ? Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2])
      : 100;
    const tol = midMatchTol(diag);
    for (const g of this.ghosts) {
      const failed = !!entry?.failed?.some(
        (e) => Math.hypot(e.mid[0] - g.mid[0], e.mid[1] - g.mid[1], e.mid[2] - g.mid[2]) <= tol,
      );
      g.color = failed ? GHOST_ERROR : GHOST_SELECT;
      if (g !== this.hoveredGhost) (g.line.material as LineMaterial).color.set(g.color);
    }
    this.viewport.requestRender();
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const hit = this.viewport.pickEdgeAt(e.clientX, e.clientY);
      this.hoverModelEdge(hit?.edge ?? null);
      this.viewport.domElement.style.cursor = hit ? "pointer" : "default";
      return;
    }
    if (this.grabbing) {
      let signed = scrubSigned({
        grabSigned: this.grabSigned,
        grabProj: this.grabProj,
        proj: this.swipeProj(e.clientX, e.clientY),
        step: this.viewport.snapStep(this.anchor, e.shiftKey),
        limit: this.limit(),
      });
      let at = treatmentAt(this.positiveKind, signed);
      // Crossing into a treatment whose field is parameter-driven would throw
      // the expression away on commit. Park the drag on the origin instead of
      // letting it through: the user can still come back out on their own side,
      // and Tab reports the same refusal in words.
      if (at.kind !== this.kind && this.paramBlocked(at.kind)) {
        signed = 0;
        at = { kind: this.kind, value: 0 };
      }
      if (signed === this.signed) return; // same step, don't re-trigger an OCCT rebuild
      const wasNeutral = this.neutral;
      const prevKind = this.kind;
      this.signed = signed;
      this.value = at.value;
      // The kind follows the sign, but only once the drag means something: at
      // the origin there is no side to be on, so the label holds still rather
      // than flickering as the cursor crosses.
      if (!this.neutral && at.kind !== this.kind) {
        this.kind = at.kind;
        this.forgetBuildRange(); // a chamfer's limit is not a fillet's
        this.mountInput();
      } else {
        this.dim.updateFromCursor({ [this.field.name]: this.value });
      }
      this.schedulePreviewDuringDrag();
      // The prompt names the treatment, so it has to keep up with both, and a
      // fast enough pointermove can land on the far side without ever reporting
      // a frame at the origin.
      if (this.neutral !== wasNeutral || this.kind !== prevKind) this.promptForPhase();
      return;
    }
    // idle: highlight the handle under the pointer so it reads as grabbable
    this.hovering = this.hitGizmo(e.clientX, e.clientY);
    if (!this.hovering) {
      // members and bare edges are toggle targets in BOTH modes, show which
      const t = this.clickTarget(e.clientX, e.clientY);
      this.hoverGhost(t?.kind === "member" ? t.g : null);
      this.hoverModelEdge(t?.kind === "edge" ? t.hit.edge : null);
      this.viewport.domElement.style.cursor = t ? "pointer" : "default";
      return;
    }
    this.hoverGhost(null);
    this.hoverModelEdge(null);
    this.viewport.domElement.style.cursor = "grab";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      const hit = this.viewport.pickEdgeAt(e.clientX, e.clientY);
      if (!hit) return; // missed an edge, let the click orbit
      e.preventDefault();
      e.stopImmediatePropagation();
      const pts = hit.edge.points;
      const { mid, tan } = midAndTangent(pts);
      this.beginDrag([hit.selector], mid, tan, hit.edge, { scope: this.scopeFor(e, hit.edge) });
      return;
    }
    // drag phase: grabbing the handle scrubs, a click on an edge toggles it
    this.downPos = { x: e.clientX, y: e.clientY };
    this.downOnGizmo = this.hitGizmo(e.clientX, e.clientY);
    if (this.downOnGizmo) {
      e.preventDefault();
      e.stopImmediatePropagation(); // don't let the camera orbit while dragging the handle
      this.grabbing = true;
      this.grabSigned = this.signed;
      this.grabProj = this.swipeProj(e.clientX, e.clientY);
      this.viewport.domElement.style.cursor = "grabbing";
      return;
    }
    // click toggles membership in BOTH modes, a member hit removes that edge,
    // a bare-edge hit adds it. Either way this press is a toggle, not a miss
    // (downOnGizmo doubles as that latch).
    const t = this.clickTarget(e.clientX, e.clientY);
    if (t) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.hoverGhost(null);
      this.hoverModelEdge(null);
      if (t.kind === "member") this.removeWithChain(t.g);
      else this.addPicked(t.hit.edge, this.scopeFor(e, t.hit.edge));
      this.afterMembershipChange();
      this.downOnGizmo = true;
      return;
    }
    // a press on a face or empty space: leave it to the camera rig
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0 || this.phase !== "drag") return;
    if (this.grabbing) {
      const moved =
        Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
      this.grabbing = false;
      // The release is one of the moments the real preview isn't allowed to
      // wait out the debounce (see schedulePreviewDuringDrag): commit and
      // cancel both want the kernel already chasing the size the drag ended on.
      this.flushPreviewNow();
      // Shared with Press/Pull, which offers the same handle over faces, see
      // fluentRelease for what each outcome is protecting against.
      const release = fluentRelease({
        fluent: this.fluentGrab,
        moved,
        meaningful: !this.neutral,
      });
      // Cleared BEFORE dispatching, not in cleanup: commit() can decline and
      // leave the tool alive (every member edge clicked back off), and a stale
      // flag would then make the NEXT release re-run this decision on a gesture
      // that ended long ago.
      this.fluentGrab = false;
      if (release === "commit") return this.commit();
      if (release === "cancel") return this.cancel();
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      if (!moved) {
        // A press that never travelled is the way IN to the full tool rather
        // than a drag. Arriving from the selection handle that means arming on
        // nothing at all, so put the default value up, the tool the user just
        // opened should have something to show and adjust.
        if (this.neutral) {
          this.setValue(seedValue(this.kind, this.bounds(), this.clearanceLimitMm));
          this.dim.updateFromCursor({ [this.field.name]: this.value });
          this.refreshGhost();
          this.pushPreview();
        }
        this.promptForPhase();
      }
      return;
    }
    // A clean click that found no edge keeps the tool and its members. Only
    // Enter or the check button apply it.
    const moved =
      Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (this.downOnGizmo || moved) return;
    if (this.memberCount()) setPrompt(missPrompt(this.kind, this.memberCount()));
    else this.promptForPhase();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      this.cancel();
      return;
    }
    // The value box handles its own Enter; this is Enter after a click on the
    // model took the focus out of it.
    if (e.key === "Enter" && this.phase === "drag" && !isEditableTarget(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.commit();
      return;
    }
    // Tab flips fillet ↔ chamfer and carries the number across, mid-drag and
    // all. Capture phase, so it reaches us whether focus sits in the heads-up
    // input or on the canvas, and so DimInput's own Tab (move to the next
    // field) never sees it. Nothing is lost there: fillet and chamfer each
    // show exactly ONE field, so tabbing between fields was already a no-op
    // that only had the side effect of locking the field against the drag.
    // The box's check on what was typed is not skipped with it: a value it
    // refuses stays put with its reason, and nothing flips.
    if (e.key === "Tab" && this.phase === "drag") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!this.dim.accepts(this.field.name)) return;
      this.flipKind();
    }
  }

  private beginDrag(
    edges: Selector[],
    anchor: THREE.Vector3,
    tangent: THREE.Vector3 | null,
    chainSource?: EdgeRef,
    opts?: { fromZero?: boolean; scope?: PickScope },
  ) {
    // Every member gets a ghost line (visible through the model) and stays
    // click-toggleable. A direct pick expands across its tangent chain; a
    // pre-selection expands each matched member's chain the same way
    // (unmatched selectors still commit, just without a visual), unless the
    // gesture is single-scoped, in which case the members ARE the answer and
    // there is nothing to expand.
    const scope = opts?.scope ?? "chain";
    if (chainSource) {
      this.addPicked(chainSource, scope);
    } else {
      this.seedGhosts(edges);
      if (scope === "chain") {
        for (const g of [...this.ghosts]) {
          const line = this.viewport.edgeLineByMid(g.mid);
          if (line) this.addPicked(line, "chain");
        }
      }
    }
    this.anchor.copy(anchor);
    this.tangent = tangent;
    this.phase = "drag";
    this.axis.copy(this.computeAxis());
    this.quat.setFromUnitVectors(Y_AXIS, this.axis);
    // Must precede the seed value below, which is clamped to these bounds, and
    // must precede pushPreview, which replaces the displayed model with one that
    // already has the blend in it.
    this.measureClearance();
    // The treatment we opened on is what the arrow's own direction means; its
    // opposite lives on the far side of the origin for the rest of the gesture.
    this.positiveKind = this.kind;
    // Both need the anchor (the snap step and the model bounds are read at it),
    // hence here rather than at the top.
    this.setValue(opts?.fromZero ? 0 : seedValue(this.kind, this.bounds(), this.clearanceLimitMm));
    this.previewId = this.store.nextId();
    // keep edges emphasized: more edges can be clicked into the set mid-drag
    this.hoverModelEdge(null);
    this.buildGizmo();
    this.mountInput();
    this.promptForPhase();
    this.refreshGhost();
    this.pushPreview();
    if (!this.unsubBuild) this.watchBuilds(null); // create mode: failure feedback only
    this.gesture.frame();
  }

  /** keep the handle a constant on-screen size + oriented, and keep a typed value
   *  previewing live (the pointer may be still while the user types). */
  /** The profile only has something to say on a fillet with members that is
   *  actually applying. Reconciled per frame rather than at the six places those
   *  can each change. */
  private syncChip() {
    this.chip?.setVisible(
      this.phase === "drag" && !this.neutral && this.currentSelectors().length > 0,
    );
  }

  /** Keep the handle standing across an orbit.
   *
   *  An edge handle's axis is defined against the CAMERA, perpendicular to the edge
   *  and in the screen plane, so it is only right for the orbit it was computed in.
   *  Computed once when the tool armed, it ended up pointing at the viewer after a
   *  far enough orbit, where a 52px glyph projects to nothing. The PASSIVE handle
   *  recomputes every frame, so the armed tool was also drifting away from the
   *  handle it is supposed to be indistinguishable from.
   *
   *  Not while a gesture is live: the axis is what the drag measures along, so
   *  moving it under a pressing hand would
   *  re-scale travel already made. Mid-gesture only the DRAWN direction leans. */
  private refreshAxis() {
    if (!this.grabbing) this.axis.copy(this.computeAxis());
    const cam = this.viewport.camera;
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const camRight = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    this.quat.setFromUnitVectors(Y_AXIS, leanOutOfView(this.axis, fwd, camRight));
  }

  private tick() {
    if (this.phase === "drag") this.refreshAxis();
    this.syncChip();
    if (this.phase === "drag" && this.gizmo) {
      const k = this.viewport.pixelWorldSize(this.anchor);
      this.gizmo.position.copy(this.anchor);
      this.gizmo.quaternion.copy(this.quat);
      // Same product as the passive handle (selectionNudge), or the glyph would
      // resize at the instant the gesture takes over from it.
      this.gizmo.scale.setScalar(k * handleScale(this.viewport.modelDiagonal(), k));
      this.handle?.paint({ hot: this.hovering || this.grabbing, refused: this.refusalShown !== null });
      const s = this.viewport.projectToScreen(this.anchor);
      this.dim.position(s.x, s.y);
      if (!this.grabbing && this.dim.isUserDriven(this.field.name)) {
        const v = this.dim.getValue(this.field.name);
        if (v != null && Math.abs(v - this.value) > 1e-6) {
          const wasNeutral = this.neutral;
          // a TYPED value is held only to the absolute floor: the drag's
          // zoom-scaled step has no business rounding a number someone chose.
          // It lands on the current treatment's side of the origin, so grabbing
          // the handle afterwards carries on from there rather than from
          // wherever the drag last left off.
          this.setValue(clampValue(v, { min: MIN_EDGE_VALUE, max: Infinity }));
          this.schedulePreviewDuringDrag();
          if (this.neutral !== wasNeutral) this.promptForPhase();
        }
      }
      this.gesture.frame();
    }
  }

  private computeAxis(): THREE.Vector3 {
    return edgeHandleAxis(this.viewport, this.tangent, this.anchor, this.modelCentre());
  }

  /** Centre of the model's bounding box, what "outward" is measured against. */
  private modelCentre(): THREE.Vector3 | null {
    const bb = this.store.buildState.result?.bbox;
    if (!bb) return null;
    return new THREE.Vector3(
      (bb.min[0] + bb.max[0]) / 2,
      (bb.min[1] + bb.max[1]) / 2,
      (bb.min[2] + bb.max[2]) / 2,
    );
  }

  private buildGizmo() {
    this.handle = createDragHandle();
    this.gizmo = this.handle.group;
    this.viewport.addToScene(this.gizmo);
  }

  private hitGizmo(x: number, y: number): boolean {
    if (!this.gizmo) return false;
    const ray = this.viewport.rayFrom(x, y);
    return ray.intersectObjects(this.gizmo.children, false).length > 0;
  }

  /** Re-anchor the gizmo/input to the new member set and refresh the preview.
   *  With zero members the preview drops back to the bare model (a fillet with
   *  no edges would just error every rebuild). */
  private afterMembershipChange() {
    const sels = this.currentSelectors();
    if (sels.length) {
      if (this.editId) this.placeOnMembers();
      else this.anchor.copy(this.anchorFromSelectors(sels));
      this.axis.copy(this.computeAxis());
      this.quat.setFromUnitVectors(Y_AXIS, this.axis);
    }
    // Before pushPreview, while the displayed model is still the one the blend
    // would be applied to (see measureClearance).
    this.measureClearance();
    this.forgetBuildRange(); // a different set of edges is a different limit
    this.refreshGhost(); // clears itself back to nothing at zero members, same as pushPreview
    this.pushPreview(); // clears itself back to the bare model at zero members
    this.promptForPhase();
  }

  private buildFeature(): Feature {
    const v = this.size();
    const sels = this.currentSelectors();
    const edges = sels.length === 1 && sels[0] ? sels[0] : sels;
    const kept = this.optionsKind === this.kind
      ? Object.fromEntries(Object.entries(this.options).filter(([, x]) => x !== undefined))
      : {};
    if (this.kind !== "fillet") return { id: this.previewId, type: "chamfer", edges, distance: v, ...kept };
    const g2 = this.continuity === "G2" ? { continuity: "G2" as const } : {};
    // Omit the field entirely at 0 rather than storing it: a plain fillet must
    // stay a plain fillet in the document, so it keeps routing to the kernel's
    // own filleter instead of through the reweighting path.
    return isPlainProfile(this.profile)
      ? { id: this.previewId, type: "fillet", edges, radius: v, ...kept, ...g2 }
      : {
          id: this.previewId,
          type: "fillet",
          edges,
          radius: v,
          profile: Math.round(this.profile * 1000) / 1000,
          ...kept,
          ...g2,
        };
  }

  private commit() {
    if (this.phase !== "drag") return this.cancel();
    this.flushPreviewNow(); // settle any pending debounce before reading this.shown below
    const v = this.dim.getValue(this.field.name);
    if (v != null && Math.abs(v - this.value) > 1e-6) {
      // Typed and confirmed inside one frame, before tick() previewed it.
      this.setValue(v);
      if (!this.neutral) this.pushPreview();
    }
    // Zero is a real answer here, not a mistake: the drag can be parked on the
    // origin on purpose, and that means "don't do this after all".
    if (this.neutral) return this.cancel();
    if (this.currentSelectors().length === 0) {
      setPrompt("Click an edge · Esc");
      return; // deleting is an explicit timeline action, not an implicit empty commit
    }
    const decision = commitDecision({
      value: this.size(),
      verdict: blendVerdict(this.range, this.size()),
      settled: this.shown !== null && Math.abs(this.shown - this.size()) < 1e-9,
      shown: this.shown,
      typed: this.dim.isUserDriven(this.field.name),
    });
    if (decision.action === "stay") return this.promptForPhase();
    if (decision.action === "cancel") return this.cancel();
    this.setValue(decision.value);
    const feature = this.buildFeature();
    if (this.editId && this.original && this.opened) {
      const edit = blendEditCommit({
        original: this.original,
        opened: this.opened,
        built: feature,
        paramRef: this.paramRef,
      });
      const refused = edit.refused
        ?? (edit.feature || edit.param ? this.store.commitFeatureEdit(this.editId, edit.feature, edit.param) : null);
      // A commit ends the preview itself; anything else puts the committed model back.
      this.store.endEditPreview();
      if (refused) toast(refused, { kind: "warning" });
    } else if (this.editId) {
      this.store.endEditPreview();
    } else {
      this.store.setPreview(null);
      this.store.addFeature(feature);
    }
    if (decision.unverified) {
      this.store.verifyCommit(feature.id, `${treatmentLabel(this.kind)} ${fmtLength(decision.value)}`);
    }
    this.cleanup();
    this.onDone?.(feature.id);
  }

  cancel() {
    if (this.editId) this.store.endEditPreview();
    else this.store.setPreview(null);
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    this.gesture.detach();
    el.style.cursor = "default";
    if (this.previewTimer != null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.viewport.clearBlendGhost();
    this.dim.hide();
    this.chip?.dispose();
    this.chip = null;
    this.profile = 0;
    this.options = {};
    this.optionsKind = null;
    this.continuity = "G1";
    this.disposeGizmo();
    this.disposeGhosts();
    this.unsubBuild?.();
    this.unsubBuild = null;
    this.editId = null;
    this.paramRef = null;
    this.original = null;
    this.opened = null;
    this.awaitingRollback = false;
    this.viewport.emphasizeEdges(false);
    this.hoverModelEdge(null);
    this.viewport.suspendPicking = false;
    this.active = false;
    this.phase = "pick";
    this.grabbing = false;
    this.fluentGrab = false;
    this.refusalShown = null;
    this.forgetBuildRange();
    this.hovering = false;
    this.signed = 0;
    this.grabSigned = 0;
    setPrompt(null);
  }

  private disposeGizmo() {
    if (!this.gizmo || !this.handle) return;
    this.viewport.removeFromScene(this.gizmo);
    this.handle.dispose();
    this.gizmo = null;
    this.handle = null;
  }

  /** Edit mode: stand the handle on the first member edge, at the point its
   *  saved selector names, with that edge's tangent. Averaging the selector
   *  points instead can land in mid air, two picks on opposite sides of one
   *  loop average to its centre. */
  private placeOnMembers() {
    const g = this.ghosts[0];
    const first = g?.sels[0];
    const at = first && "point" in first ? (first.point as Vec3) : g?.mid;
    const place = g && at ? pointOnEdge(g.points, at) : null;
    if (!place) {
      this.anchor.copy(this.anchorFromSelectors(this.currentSelectors()));
      this.tangent = null;
      return;
    }
    this.anchor.set(...place.anchor);
    this.tangent = place.tangent ? new THREE.Vector3(...place.tangent) : null;
  }

  /** Anchor for a pre-selection: average the selector points (nearest selectors
   *  carry their edge midpoint), else fall back to the model's bbox centre. */
  private anchorFromSelectors(sels: Selector[]): THREE.Vector3 {
    const acc = new THREE.Vector3();
    let n = 0;
    for (const s of sels) {
      if ("point" in s) {
        acc.add(new THREE.Vector3(s.point[0], s.point[1], s.point[2]));
        n++;
      }
    }
    if (n > 0) return acc.multiplyScalar(1 / n);
    const bb = this.store.buildState.result?.bbox;
    if (bb) {
      return new THREE.Vector3(
        (bb.min[0] + bb.max[0]) / 2,
        (bb.min[1] + bb.max[1]) / 2,
        (bb.min[2] + bb.max[2]) / 2,
      );
    }
    return acc;
  }
}

/** midpoint + unit tangent (first→last) of an edge polyline */
function midAndTangent(pts: [number, number, number][]): {
  mid: THREE.Vector3;
  tan: THREE.Vector3;
} {
  const m = polylineMid(pts);
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (!a || !b || !m) return { mid: new THREE.Vector3(), tan: new THREE.Vector3(1, 0, 0) };
  const tan = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (tan.lengthSq() < 1e-9) tan.set(1, 0, 0);
  else tan.normalize();
  return { mid: new THREE.Vector3(m[0], m[1], m[2]), tan };
}
