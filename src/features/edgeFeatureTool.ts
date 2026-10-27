// Interactive Fillet / Chamfer, previewed by the engine (store.setPreview) since a real blend needs OCCT. The drag is
// a swipe (edgeSwipe.ts): `value` its size, `signed` its side, `kind` read from that side, kept at the origin.

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
import { DimInput, type DimSegment } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import {
  createDragHandle,
  nameHandle,
  edgeHandleAxis,
  HANDLE_UP,
  handleScale,
  leanOutOfView,
  type DragHandle,
} from "./manipulator";
import { swipeOffsetPx } from "./edgeSwipe";
import { clearanceLimit, localClearance } from "./blendClearance";
import { fmtLength } from "../ui/units";
import { ProfileChip } from "./profileChip";
import { clampProfile, formatProfile, isPlainProfile } from "./profileArcMath";
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
import { hitPx } from "../input/pointerKind";
import { edgeHoverColor, edgeSelectColor } from "../viewport/highlight";
import { onThemeChange } from "../ui/theme";
import { toast } from "../ui/toast";
import { isEditableTarget } from "../ui/focus";

type Phase = "pick" | "drag";
type Kind = EdgeTreatment;
type Vec3 = [number, number, number];

const Y_AXIS = HANDLE_UP;
// Ghost member lines drawn over the preview, where the members were consumed into rounded faces, in the Highlighter's
// selected edge colour, or its error red.
const GHOST_ERROR = 0xe23b3b;
const ghostColor = (g: { failed: boolean }) => (g.failed ? GHOST_ERROR : edgeSelectColor());

/** Only delays the OCCT preview; the client side ghost (viewport.setBlendGhost) still redraws every frame, so a fast
 *  drag does not queue a rebuild per pixel. */
const PREVIEW_DEBOUNCE_MS = 150;

export type Continuity = "G1" | "G2";
/** One segment per profile, in order, so a later G3 is one more entry. */
export const CONTINUITY_SEGMENTS: (DimSegment & { id: Continuity })[] = [
  { id: "G1", label: "G1, circular round", text: "G1", icon: "continuityG1", key: "1" },
  { id: "G2", label: "G2, curvature continuous", text: "G2", icon: "continuityG2", key: "2" },
];

/** Chain members toggle as one unit, recorded at add time since the preview may consume the edges and the chain could
 *  not be recomputed from the displayed model. */
interface GhostEdge {
  /** stable per-member id, the key the member panel removes a row by */
  id: number;
  /** Usually one; a saved feature can name one edge twice (two points on a closed loop) and the commit keeps both. */
  sels: Selector[];
  mid: Vec3;
  points: Vec3[];
  line: Line2;
  chain: number;
  /** drawn in the error red when not hovered */
  failed: boolean;
}

/** An unresolved row is a saved selector the current geometry no longer shows: still part of the feature and
 *  removable, but with no line to click in the view. */
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
  // Unit. Frozen for a gesture, but re-derived against the camera every idle frame so an orbit cannot leave the
  // handle pointing at the viewer (refreshAxis).
  private axis = new THREE.Vector3(1, 0, 0);
  private quat = new THREE.Quaternion(); // Y -> axis, for orienting the handle
  private tangent: THREE.Vector3 | null = null; // edge direction (null = pre-selection fallback)
  /** Where the most recently picked edge's middle was, so the handle stays on it as other members come and go. */
  private lastPickMid: Vec3 | null = null;
  private value = 2; // radius / distance in mm, a MAGNITUDE, never negative
  /** Position on the drag axis: |signed| is `value`, and its sign picks between
   *  `positiveKind` and its opposite. 0 means "no feature here". */
  private signed = 2;
  /** What the arrow's own direction means. Fixed when the gesture opens, swapped by Tab so the pointer can stay. */
  private positiveKind: Kind = "fillet";
  private previewId = ""; // id shared by the live preview and the committed feature

  // Every member is a ghost line drawn through the model (depthTest off), so hidden members stay visible and clickable.
  private ghosts: GhostEdge[] = []; // membership display + toggle targets
  private unmatchedSels: Selector[] = []; // saved selectors we couldn't visualize (kept for commit)

  private editId: string | null = null; // committed feature id being edited
  private awaitingRollback = false; // waiting for the rolled-back model build
  private unsubBuild: (() => void) | null = null;
  private unsubTheme: (() => void) | null = null;
  /** Set when the edited field is a bare reference to another parameter (store.bareParamRef): commit writes the drag's
   *  value into that parameter and the field stays bound. */
  private paramRef: string | null = null;
  /** The committed feature and what buildFeature() made of it when the edit opened; commit takes only what differs
   *  from `opened` (features/blendEdit.ts). */
  private original: Feature | null = null;
  private opened: Feature | null = null;

  private gizmo: THREE.Group | null = null;
  private handle: DragHandle | null = null;
  /** Fillet only: a chamfer's section is the chord. */
  private chip: ProfileChip | null = null;
  /** In (-1, 1), 0 is the plain circular fillet. Survives a Tab to chamfer and back. */
  private profile = 0;
  /** Options the drag does not set, kept from the edited feature so a re-edit does not reset them. */
  private options: Record<string, unknown> = {};
  private optionsKind: Kind | null = null;
  private continuity: Continuity = "G1";
  private hovering = false;
  private grabbing = false;
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

  /** Null before there is geometry. Not cached: it moves with every rebuild, and the preview rebuilds all drag long. */
  private modelDiagonal(): number | null {
    const bb = this.store.buildState.result?.bbox;
    if (!bb) return null;
    return Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
  }

  /** Measured once per member set and held. Once the drag starts the displayed model is the preview, whose new faces
   *  sit where the clearance is measured, so a per frame read would shrink the bound as the value grew. */
  private clearanceLimitMm: number | null = null;

  private measureClearance() {
    const all = this.viewport.visibleEdgeLines().map((e) => ({ id: e.id, points: e.points }));
    // Picked edges are matched by geometry, not model edge ids, which the preview renumbers; localClearance already
    // drops chain mates sharing a vertex as inside the touch tolerance.
    const selected = this.ghosts.map((g, i) => ({ id: `pick:${i}`, points: g.points }));
    this.clearanceLimitMm = clearanceLimit(localClearance({ selected, all, modelScale: this.modelDiagonal() ?? 0 }));
  }

  /** mm from the picked edge, signed by the cursor's side (features/edgeSwipe.ts). Directions are projected from a
   *  40px world step at the anchor: long enough to beat rounding, short enough that perspective has not bent it. */
  private swipeProj(clientX: number, clientY: number): number {
    const px = this.viewport.pixelWorldSize(this.anchor);
    const step = px * 40;
    const o = this.viewport.projectToScreen(this.anchor);
    const along = (v: THREE.Vector3) => {
      const p = this.viewport.projectToScreen(this.anchor.clone().addScaledVector(v, step));
      return { x: p.x - o.x, y: p.y - o.y };
    };
    // No tangent means a multi edge pre-selection; edgeSwipe falls back to travel along the arrow.
    const edgeDir = this.tangent ? along(this.tangent) : { x: 0, y: 0 };
    return swipeOffsetPx(o, edgeDir, along(this.axis), { x: clientX, y: clientY }) * px;
  }

  /** See blendVerdict. Reset when the question changes (treatment, profile or members), or the old limit would
   *  refuse the new one. */
  private range: BlendRange = EMPTY_BLEND_RANGE;
  /** What the kernel said the last time it refused this question. */
  private refusal: { code: string | null; message: string } | null = null;
  /** Null when the screen shows no blend of ours. A refused size keeps the previous one on screen (store.setPreview's
   *  hold), so a refused confirm commits this. */
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
    return !this.neutral && this.currentSelectors().length > 0 && blendVerdict(this.range, this.size()) === "refused";
  }

  /** On the handle, the value box and the prompt; cheap enough to run on every value change. */
  private refreshRefusal() {
    const reason =
      this.refusedNow && this.refusal ? blendRefusalReason(this.kind, this.memberCount(), this.refusal) : null;
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

  /** `opts` is the direct entry (features/edgeNudge.ts): a press on the selection handle arms and starts scrubbing in
   *  the same pointerdown. Its `tangent` is adopted so the handle does not jump at the grab. */
  start(
    kind: Kind,
    onDone: (id: string | null) => void,
    opts?: { tangent?: THREE.Vector3 | null; grabAt?: { x: number; y: number }; anchor?: THREE.Vector3 },
  ) {
    if (this.active) return;
    // The direct entry needs the selection its handle was drawn for. If a rebuild landed between paint and press,
    // refuse before installing anything rather than arm an unasked pick phase that holds toolBusy().
    const pre = this.viewport.selectedEdgeSelectors();
    if (opts?.grabAt && !pre.length) return;
    // A selected face stands for every edge around it. Asking toolCapabilities.ts here keeps the table and the
    // behaviour in step, and opens the face route from every entry point at once.
    const seed = pre.length ? pre : canConsume(kind, "face") ? this.faceEdgeSelectors() : [];
    this.active = true;
    this.kind = kind;
    this.phase = "pick";
    this.onDone = onDone;
    this.tangent = null;
    this.lastPickMid = null;
    this.viewport.suspendPicking = true; // we drive our own edge-only picking
    this.viewport.emphasizeEdges(true); // light up all edges so they're easy to target
    this.gesture.attach();
    this.unsubTheme = onThemeChange(() => this.recolorGhosts());

    if (seed.length) {
      // A handle grab opens at 0, so the drag is the radius and the press point means no feature; a command opens on
      // the default. The handle's own anchor is kept, it may stand where the edge was clicked.
      this.beginDrag(seed, opts?.anchor?.clone() ?? null, opts?.tangent ?? null, undefined, {
        fromZero: !!opts?.grabAt,
        // A face's edges are the complete set asked for, chain expansion could only add edges off the face. An edge
        // pre-selection keeps the scope its own picks decided (pickScope.ts).
        scope: pre.length ? this.viewport.selectedEdgeScope().scope : "single",
      });
      if (opts?.grabAt) this.grabHandle(opts.grabAt.x, opts.grabAt.y);
    } else {
      setPrompt(`Click an edge to ${kind} · Ctrl-click a chain · Shift-click one · or pick a face`);
    }
  }

  /** [] when no face is selected. viewport/faceEdges.ts finds the edges by geometry, since the rebuild reply has no
   *  face to edge topology. */
  private faceEdgeSelectors(): Selector[] {
    return this.viewport.edgesOfSelectedFaces().flatMap((line): Selector[] => {
      const sel = edgeSelectorFrom({ points: line.points, body: line.body });
      return sel ? [sel] : [];
    });
  }

  /** The press that started the gesture landed on the passive selection handle before this tool existed, so there is
   *  no pointerdown of our own. */
  private grabHandle(clientX: number, clientY: number) {
    if (this.phase !== "drag") return;
    this.grabbing = true;
    this.downOnGizmo = true;
    this.downPos = { x: clientX, y: clientY };
    this.grabSigned = this.signed;
    this.grabProj = this.swipeProj(clientX, clientY);
    this.viewport.domElement.style.cursor = "grabbing";
  }

  /** Rolls the model back to just before the feature and shows its edges as ghosts; commit writes only what changed
   *  (same id, name and binding, one undo step). False when it cannot be tool edited (an expression value, or
   *  selectors without a point) and the caller falls back to the value rows. */
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
    // A real expression stays refused: a drag writes a plain number, which "wall_blend_r * 2" is not.
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
    this.profile = f.type === "fillet" && typeof f.profile === "number" ? clampProfile(f.profile) : 0;
    this.continuity = f.type === "fillet" && f.continuity === "G2" ? "G2" : "G1";
    this.options =
      f.type === "fillet"
        ? { sizeType: f.sizeType, tangentEdges: f.tangentEdges }
        : { chamferType: f.chamferType, distance2: f.distance2, tangentEdges: f.tangentEdges };
    this.optionsKind = f.type;
    this.unmatchedSels = [];
    this.awaitingRollback = true;

    this.viewport.suspendPicking = true;
    this.viewport.emphasizeEdges(true); // additions should be easy to see
    this.gesture.attach();
    setPrompt("Rolling back to edit…");

    // The next completed build shows the sharp member edges, snapshotted as ghosts before the preview goes back on top.
    this.store.beginEditPreview(featureId);
    this.watchBuilds(sels);
    return true;
  }

  /** Edit mode also uses the first build to snapshot the rolled back sharp edges; create mode passes null and only
   *  wants the kernel's verdicts. */
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

  /** Records the size that was sent, often no longer the handle's during a fast drag. A reply for another question
   *  (treatment, edges or profile) says nothing about this one. */
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
    // The ghost ends once the real geometry for this size is on screen; a held refusal swaps it for the capped one.
    // An older size mid debounce is `current` too but fails `this.size()`, so the ghost stays.
    if (current && held) this.refreshGhost();
    else if (current && size !== null && Math.abs(size - this.size()) < 1e-9) {
      this.viewport.clearBlendGhost();
    }
  }

  /** Unmatched selectors are kept for commit with no visual; the engine resolves them by nearest at build time. */
  private seedGhosts(sels: Selector[]) {
    for (const sel of sels) {
      if ("point" in sel) this.lastPickMid = sel.point as Vec3;
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
      color: edgeSelectColor(),
      linewidth: 3.5,
      worldUnits: false,
      depthTest: false,
      transparent: true,
    });
    mat.resolution.set(el.clientWidth, el.clientHeight);
    const line = new Line2(geo, mat);
    line.renderOrder = 998;
    this.viewport.addToScene(line);
    this.ghosts.push({
      id: ++this.memberSeq,
      sels: [sel],
      mid,
      points,
      line,
      chain: chain ?? ++this.chainCounter,
      failed: false,
    });
  }

  // Member panel (ui/FilletMembers.vue): the same ghost list as rows, the only way to reach unresolved members.

  /** The pick phase, with no members yet, shows nothing. */
  editingMembers(): boolean {
    return this.active && this.phase === "drag";
  }

  /** Follows a Tab flip. */
  blendKind(): "fillet" | "chamfer" {
    return this.kind;
  }

  /** Matched edges, then unresolved saved selectors. Read fresh each poll so it follows viewport edits too. */
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

  /** A resolved row takes its whole tangent chain, as a click does, since a blend cannot end mid tangency; an
   *  unresolved row removes only itself. */
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

  /** Adding is already a click on an edge in the view, so this only says so. */
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

  /** Within the model edge grab radius, measured along the projected polyline's segments since Line2 raycast is
   *  finicky with tool owned materials. */
  private ghostAt(clientX: number, clientY: number): { g: GhostEdge; dist: number } | null {
    let best: { g: GhostEdge; dist: number } | null = null;
    // Sized for the pointer in use, the same as the model edge pick it competes with.
    const grab = hitPx(EDGE_GRAB_PX);
    for (const g of this.ghosts) {
      const pts = g.points.map((p) => this.viewport.projectToScreen(new THREE.Vector3(p[0], p[1], p[2])));
      const dist = screenPolylineDist(pts, { x: clientX, y: clientY });
      if (dist <= grab && (!best || dist < best.dist)) best = { g, dist };
    }
    return best;
  }

  private clickTarget(
    clientX: number,
    clientY: number,
  ): { kind: "member"; g: GhostEdge } | { kind: "edge"; hit: NonNullable<ReturnType<Viewport["pickEdgeAt"]>> } | null {
    const ghost = this.ghostAt(clientX, clientY);
    const hit = this.viewport.pickEdgeAt(clientX, clientY);
    const t = blendClickTarget(ghost?.dist ?? null, hit?.rankPx ?? null, hitPx(EDGE_GRAB_PX));
    if (t === "member" && ghost) return { kind: "member", g: ghost.g };
    if (t === "edge" && hit) return { kind: "edge", hit };
    return null;
  }

  private hoveredGhost: GhostEdge | null = null;

  /** Drawn again wide on top, since the tint alone is hard to tell from the other lit edges. */
  private hoverModelEdge(edge: EdgeRef | null) {
    this.viewport.hoverEdge(edge);
    this.viewport.emphasiseEdge(edge);
  }

  private hoverGhost(g: GhostEdge | null) {
    if (g === this.hoveredGhost) return;
    const prev = this.hoveredGhost;
    this.hoveredGhost = g;
    if (prev && this.ghosts.includes(prev)) (prev.line.material as LineMaterial).color.set(ghostColor(prev));
    if (g) (g.line.material as LineMaterial).color.set(edgeHoverColor());
    this.viewport.requestRender();
  }

  // A blend cannot end mid tangency (OCCT cannot stop it at the joint), so every pick expands across tangent
  // continuous edges and deselection removes the same chain.

  /** Breadth first across shared endpoints whose end tangents are colinear, `start` included. */
  private tangentChain(start: EdgeRef): EdgeRef[] {
    const all = this.viewport.visibleEdgeLines();
    const bb = this.store.buildState.result?.bbox;
    const diag = bb ? Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) : 100;
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
      const tHead = new THREE.Vector3(second[0] - first[0], second[1] - first[1], second[2] - first[2]).normalize();
      const tTail = new THREE.Vector3(last[0] - prev[0], last[1] - prev[1], last[2] - prev[2]).normalize();
      return [
        { p: first, t: tHead },
        { p: last, t: tTail },
      ];
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

  /** Takes the tangent chain along or not by `scope` (viewport/pickScope.ts). The gesture shares one chain id either
   *  way, so it deselects as one unit. */
  private addPicked(line: EdgeRef, scope: PickScope) {
    const chainId = ++this.chainCounter;
    this.lastPickMid = polylineMid(line.points as Vec3[]) ?? null;
    for (const l of scope === "single" ? [line] : this.tangentChain(line)) {
      const pts = l.points as Vec3[];
      const sel = edgeSelectorFrom({ points: pts, body: l.body });
      if (!sel) continue;
      const mid = sel.point;
      if (this.ghosts.some((g) => Math.hypot(g.mid[0] - mid[0], g.mid[1] - mid[1], g.mid[2] - mid[2]) < 1e-6)) continue;
      this.addGhost(sel, pts, chainId);
    }
  }

  /** Same rule as the picks that armed the tool (viewport/pickScope.ts), so adding mid gesture behaves the same. */
  private scopeFor(e: PointerEvent, edge: EdgeRef): PickScope {
    return pickScope({ shift: e.shiftKey, view: this.viewport.edgeScopeView(edge) }).scope;
  }

  /** The chain id is recorded at add time, so this works after the preview consumed the chain's edges. */
  private removeWithChain(g: GhostEdge) {
    for (const ghost of [...this.ghosts]) {
      if (ghost.chain === g.chain) this.removeGhost(ghost);
    }
  }

  private enterEditUI() {
    this.placeOnMembers();
    this.axis.copy(this.computeAxis());
    this.quat.setFromUnitVectors(Y_AXIS, this.axis);
    // Only reached once the rollback build landed, so the model shown is the one without this feature, the geometry
    // the blend must fit into.
    this.measureClearance();
    this.buildGizmo();
    this.mountInput();
    this.promptForPhase();
    this.gesture.frame();
  }

  /** DimInput builds its fields once in show(), so switching the shown field (every Tab and origin crossing)
   *  rebuilds the box. `keepTyped` locks the value as the user's own rather than letting the drag track over it. */
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
    this.dim.show(
      [{ ...field, kind: "length", ...featureValueRule(this.kind, this.field.name) }],
      () => this.commit(),
      () => this.cancel(),
      this.kind === "fillet"
        ? {
            name: "continuity",
            title: "Continuity: G1 is a circular round, G2 eases into the faces with no jump in curvature",
            segments: CONTINUITY_SEGMENTS,
            chosen: this.continuity,
            onChoose: (id) => {
              this.continuity = id as Continuity;
              this.forgetBuildRange(); // G2 sets back further, so its limit is not G1's
              this.pushPreview();
            },
          }
        : undefined,
      this.chip?.el,
    );
    this.dim.showOwnProblem(this.refusalShown);
    if (keepTyped) this.dim.seed(this.field.name, this.value);
    else this.dim.updateFromCursor({ [this.field.name]: this.value });
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
  }

  /** Keeps `signed` in step on the current treatment's side, so the next grab picks up from here. */
  private setValue(v: number) {
    this.value = v;
    this.signed = (this.kind === this.positiveKind ? 1 : -1) * v;
  }

  /** The committed field for `k` is bound and commit writes a plain number; startEdit's refusal, for the field being
   *  switched into. */
  private paramBlocked(k: Kind): boolean {
    if (!this.editId) return false;
    // A bare parameter reference cannot follow to a field it is not bound to.
    if (this.paramRef) return true;
    return this.store.isParamBound({
      kind: "feature",
      feature: this.editId,
      field: treatmentField(k).name,
    });
  }

  /** Ghosted plus unmatched saved selectors. */
  private currentSelectors(): Selector[] {
    return [...this.unmatchedSels, ...this.ghosts.flatMap((g) => g.sels)];
  }

  /** Two selectors on one edge count once. */
  private memberCount(): number {
    return this.unmatchedSels.length + this.ghosts.length;
  }

  /** What Tab does. A typed value has no side of the origin, so this flips the treatment in place and which side
   *  means it, or the next pointermove would read the old sign and undo the flip. */
  private flipKind() {
    if (this.phase !== "drag") return;
    const prevName = this.field.name;
    const typed = this.dim.isUserDriven(prevName);
    if (typed) {
      const v = this.dim.getValue(prevName);
      if (v != null) this.value = v; // a typed number is preferred over the drag's
    }
    // A typed number is held to the absolute floor only; the drag bounds would round a deliberate 0.2 mm to the snap.
    const bounds = typed ? { min: MIN_EDGE_VALUE, max: Infinity } : this.bounds();
    const next = switchTreatment(this.kind, this.value, bounds);
    if (this.paramBlocked(next.kind)) {
      setPrompt(`This feature's ${treatmentField(next.kind).name} is driven by a parameter, change it in the history`);
      return;
    }
    this.kind = next.kind;
    this.positiveKind = otherTreatment(this.positiveKind);
    this.forgetBuildRange(); // a chamfer's limit is not a fillet's
    // At the origin only the treatment flips; switchTreatment's clamp would conjure a 0.001 mm feature from "none".
    this.setValue(this.value < MIN_EDGE_VALUE ? 0 : next.value);
    this.mountInput(typed);
    this.refreshGhost(); // the ghost's SHAPE flips fillet <-> chamfer here too
    this.pushPreview();
    this.promptForPhase();
  }

  /** On the origin: no treatment, no preview, nothing to commit. */
  private get neutral() {
    return this.value < MIN_EDGE_VALUE;
  }

  /** One function since five things move under it: treatment, member count, create or edit, the origin, and a
   *  kernel refusal. */
  private promptForPhase() {
    const n = this.memberCount();
    if (!n) {
      setPrompt("Click an edge · Esc");
      return;
    }
    if (this.neutral) {
      setPrompt(`Drag out for a ${this.positiveKind}, back for a ${otherTreatment(this.positiveKind)} · Esc`);
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
    // The profile is mentioned only on a fillet, with its number only off the circular default.
    const prof =
      this.kind === "fillet" && !isPlainProfile(this.profile) ? ` · profile ${formatProfile(this.profile)}` : "";
    const param = this.paramRef ? ` · sets parameter "${this.paramRef}"` : "";
    setPrompt(
      `${treatmentLabel(this.kind)}, ${n} edge${n === 1 ? "" : "s"} · drag or type a ${this.field.name}${prof}${param} · Tab · Enter · Esc`,
    );
  }

  /** Edit mode replaces the committed feature in place, create mode appends. No members or a drag on the origin
   *  would build a blend OCCT refuses on every pointermove, so both drop back to the bare model. */
  private pushPreview() {
    if (this.neutral || !this.currentSelectors().length) {
      if (this.editId) this.store.setEditPreview(null);
      else this.store.setPreview(null);
      this.shown = null;
      this.refreshRefusal();
      return;
    }
    // A refused size is not asked again; the model keeps the last size that built meanwhile.
    if (blendVerdict(this.range, this.size()) !== "refused") {
      // A draft builds quicker and coarser during the drag; commit builds the real one.
      const feature = { ...this.buildFeature(), draft: true } as Feature;
      if (this.editId) this.store.setEditPreview(feature, { hold: true });
      else this.store.setPreview(feature, { hold: true });
    }
    this.refreshRefusal();
  }

  /** Client side approximation each drag tick (features/blendGhost.ts, normals from viewport/ghosts.ts). The exact
   *  mesh replaces it once a matching reply lands (noteBuildOutcome), which is why it may be slightly wrong. */
  private refreshGhost() {
    if (this.neutral || !this.ghosts.length) {
      this.viewport.clearBlendGhost();
      return;
    }
    // A refused size is never drawn, it would show a round the faces cannot hold; it stops in red at the shown size.
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

  /** The ghost updates now, the engine waits until the size holds for PREVIEW_DEBOUNCE_MS or flushPreviewNow.
   *  Discrete actions (Tab, members) call pushPreview directly. */
  private schedulePreviewDuringDrag() {
    // The verdict is often known from the range, so the refusal banner follows now rather than after a build.
    this.refreshRefusal();
    this.refreshGhost();
    if (this.previewTimer != null) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      this.pushPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  /** A no-op when nothing is pending, so it is safe on every release. */
  private flushPreviewNow() {
    if (this.previewTimer == null) return;
    window.clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.pushPreview();
  }

  /** The edgeOpFailed diagnostic carries the failed edges' midpoints. */
  private recolorGhostsFromDiagnostics(diags: import("../types").ResolveDiag[] | undefined) {
    const entry = diags?.find((d) => d.kind === "edgeOpFailed" && d.feature_id === this.previewId && d.failed?.length);
    const bb = this.store.buildState.result?.bbox;
    const diag = bb ? Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) : 100;
    const tol = midMatchTol(diag);
    for (const g of this.ghosts) {
      const failed = !!entry?.failed?.some(
        (e) => Math.hypot(e.mid[0] - g.mid[0], e.mid[1] - g.mid[1], e.mid[2] - g.mid[2]) <= tol,
      );
      g.failed = failed;
    }
    this.recolorGhosts();
  }

  private recolorGhosts() {
    for (const g of this.ghosts) {
      (g.line.material as LineMaterial).color.set(g === this.hoveredGhost ? edgeHoverColor() : ghostColor(g));
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
      // Crossing into a parameter driven field would drop the expression on commit, so the drag parks on the origin;
      // Tab reports the same refusal in words.
      if (at.kind !== this.kind && this.paramBlocked(at.kind)) {
        signed = 0;
        at = { kind: this.kind, value: 0 };
      }
      if (signed === this.signed) return; // same step, don't re-trigger an OCCT rebuild
      const wasNeutral = this.neutral;
      const prevKind = this.kind;
      this.signed = signed;
      this.value = at.value;
      // At the origin there is no side, so the label holds still rather than flickering at the crossing.
      if (!this.neutral && at.kind !== this.kind) {
        this.kind = at.kind;
        this.forgetBuildRange(); // a chamfer's limit is not a fillet's
        this.mountInput();
      } else {
        this.dim.updateFromCursor({ [this.field.name]: this.value });
      }
      this.schedulePreviewDuringDrag();
      // The prompt names the treatment, and a fast pointermove can cross without a frame at the origin.
      if (this.neutral !== wasNeutral || this.kind !== prevKind) this.promptForPhase();
      return;
    }
    this.hovering = this.hitGizmo(e.clientX, e.clientY);
    if (!this.hovering) {
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
    // Either way this press is a toggle, not a miss (downOnGizmo doubles as that latch).
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
      const moved = Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
      this.grabbing = false;
      // Letting go only ends the drag, the box options and Enter are still to come.
      this.flushPreviewNow();
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      this.dim.focus();
      if (!moved) {
        // A press that never travelled opens the full tool; from the selection handle that arms on nothing, so put
        // the default value up.
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
    // A clean click that found no edge keeps the tool and its members; only Enter or the check button apply it.
    const moved = Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (this.downOnGizmo || moved) return;
    if (this.memberCount()) setPrompt(missPrompt(this.kind, this.memberCount()));
    else this.promptForPhase();
    this.dim.focus();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      this.cancel();
      return;
    }
    // The value box handles its own Enter; this is Enter after a click on the model took the focus.
    if (e.key === "Enter" && this.phase === "drag" && !isEditableTarget(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.commit();
      return;
    }
    // Captured, so it reaches us from the heads-up input or the canvas and DimInput's own Tab never sees it; each
    // treatment shows one field, so nothing is lost. A value the box refuses stays put and nothing flips.
    if (e.key === "Tab" && this.phase === "drag") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!this.dim.accepts(this.field.name)) return;
      this.flipKind();
    }
  }

  /** A null `anchor` stands the handle on the most recently picked edge. */
  private beginDrag(
    edges: Selector[],
    anchor: THREE.Vector3 | null,
    tangent: THREE.Vector3 | null,
    chainSource?: EdgeRef,
    opts?: { fromZero?: boolean; scope?: PickScope },
  ) {
    // Each member's tangent chain is expanded unless the gesture is single scoped; unmatched selectors still commit,
    // just without a visual.
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
    if (anchor) {
      this.anchor.copy(anchor);
      this.tangent = tangent;
    } else this.placeOnLastPick();
    this.phase = "drag";
    this.axis.copy(this.computeAxis());
    this.quat.setFromUnitVectors(Y_AXIS, this.axis);
    // Before the seed value, which is clamped to these bounds, and before pushPreview puts the blend in the model.
    this.measureClearance();
    // The opening treatment is what the arrow's own direction means for the rest of the gesture.
    this.positiveKind = this.kind;
    // Here because both read the anchor (the snap step and the model bounds are measured at it).
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

  /** Reconciled per frame rather than at the six places a fillet's members or application can change. */
  private syncChip() {
    this.chip?.setVisible(this.phase === "drag" && !this.neutral && this.currentSelectors().length > 0);
  }

  /** The axis is perpendicular to the edge in the screen plane, right for one view only, so it is recomputed every
   *  frame like the passive handle. Not during a gesture, which measures along it; then only the drawn one leans. */
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
          // A typed value is held only to the absolute floor, not the drag's zoom scaled step, and lands on the
          // current treatment's side so a later grab carries on from it.
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

  /** What "outward" is measured against. */
  private modelCentre(): THREE.Vector3 | null {
    const bb = this.store.buildState.result?.bbox;
    if (!bb) return null;
    return new THREE.Vector3((bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2);
  }

  private buildGizmo() {
    this.handle = nameHandle(createDragHandle(), "size");
    this.gizmo = this.handle.group;
    this.viewport.addToScene(this.gizmo);
  }

  private hitGizmo(x: number, y: number): boolean {
    const gizmo = this.gizmo;
    if (!gizmo) return false;
    return this.viewport.probe(x, y, (rc) => rc.intersectObjects(gizmo.children, false).length > 0) ?? false;
  }

  /** With zero members the preview drops back to the bare model, a fillet with no edges would error every rebuild. */
  private afterMembershipChange() {
    const sels = this.currentSelectors();
    if (sels.length) {
      if (this.editId) this.placeOnMembers();
      else this.placeOnLastPick();
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
    const kept =
      this.optionsKind === this.kind
        ? Object.fromEntries(Object.entries(this.options).filter(([, x]) => x !== undefined))
        : {};
    if (this.kind !== "fillet") return { id: this.previewId, type: "chamfer", edges, distance: v, ...kept };
    const g2 = this.continuity === "G2" ? { continuity: "G2" as const } : {};
    // Omitted at 0 so a plain fillet stays plain in the document and keeps routing to the kernel's own filleter
    // rather than the reweighting path.
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
    // Zero on purpose means "don't do this after all".
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
      const refused =
        edit.refused ??
        (edit.feature || edit.param ? this.store.commitFeatureEdit(this.editId, edit.feature, edit.param) : null);
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
    this.unsubTheme?.();
    this.unsubTheme = null;
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

  /** Edit mode: the first member edge at its saved point. Averaging the points can land in mid air, two picks across
   *  a loop average to its centre. */
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

  /** Create mode: the middle of the most recently picked edge, across it, as the passive handle stands
   *  (edgeNudge.handlePlacement). An average of several edges lands in mid air. */
  private placeOnLastPick() {
    const at = this.lastPickMid;
    const away = (g: GhostEdge) => (at ? Math.hypot(g.mid[0] - at[0], g.mid[1] - at[1], g.mid[2] - at[2]) : 0);
    // Nearest rather than equal: a seeded selector's point and its matched edge's middle differ by rounding.
    const g = at
      ? this.ghosts.reduce<GhostEdge | null>((b, x) => (!b || away(x) < away(b) ? x : b), null)
      : this.ghosts.at(-1);
    const place = g ? pointOnEdge(g.points, g.mid) : null;
    if (!place) {
      this.anchor.copy(this.anchorFromSelectors(this.currentSelectors()));
      this.tangent = null;
      return;
    }
    this.anchor.set(...place.anchor);
    this.tangent = place.tangent ? new THREE.Vector3(...place.tangent) : null;
  }

  /** The last selector's point (a nearest selector carries its edge midpoint), else the model's bbox centre. */
  private anchorFromSelectors(sels: Selector[]): THREE.Vector3 {
    for (let i = sels.length - 1; i >= 0; i--) {
      const s = sels[i]!;
      if ("point" in s) return new THREE.Vector3(s.point[0], s.point[1], s.point[2]);
    }
    const bb = this.store.buildState.result?.bbox;
    if (bb) {
      return new THREE.Vector3((bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2);
    }
    return new THREE.Vector3();
  }
}

/** The tangent is unit, first point to last. */
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
