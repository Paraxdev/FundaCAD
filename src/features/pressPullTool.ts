// Press/Pull: drag a face along its normal to add or cut material, or resize a round face. A real surface offset
// needs OCCT, so the preview is the engine's: store.setPreview() appends the feature and commit promotes it.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore, RebuildState, SketchBinding } from "../document/store";
import type { FaceAxisReply } from "../geometry/client";
import type { Feature, PressPullDirection, PressPullMode, Selector, Vec3 } from "../types";
import { carryTaker, carryWords, pickOfHit, type CarryCommit, type CarryHost } from "./carryOn";
import { awaitTreePick, type TreePickAnswer } from "../ui/treePick";
import { PARALLEL_COS, planarPushFaces, type PushFaces } from "./pushOutline";
import { sweepPolylines } from "./sweepOutline";
import { ToolOutline } from "./toolOutline";
import {
  DimInput,
  type DimChoice,
  type DimChoices,
  type DimFieldDef,
  type DimOption,
  type DimSegmentedDef,
  type DimToggleDef,
} from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { t } from "../i18n";
import { gizmoMoveStep, taperStep } from "../viewport/gizmoStep";
import { fmtLength, snap } from "../ui/units";
import {
  axisDragDistance,
  createDragHandle,
  nameHandle,
  createRotationArc,
  HANDLE_LENGTH,
  HANDLE_UP,
  type DragHandle,
} from "./manipulator";
import { draftAngle, draftDelta } from "./draftMath";
import { COLLAPSE_FRACTION, facetNormalAt, radialDrag, roundFromResize, type RoundFace } from "./radialDrag";
import {
  defaultQuantity,
  deltaForSize,
  isAbsolute,
  parseSizeText,
  sizeReadout,
  type SizeQuantity,
} from "./sizeQuantity";
import { CanvasGesture } from "./canvasGesture";
import { HeldSignal } from "./heldEdit";
import { trackedFace } from "./holeFace";
import { commitDecision } from "./edgeDragMath";
import {
  anchorOnAxis,
  DIRECTION_LABEL,
  initialDirection,
  offeredAxis,
  offeredResize,
  resizeAxis,
  type HoleAxis,
  type OfferedResize,
  type ResizeAxis,
} from "./pressPullAxis";
import { featureKey, PreviewOutcomes } from "./previewOutcomes";
import { axialSpan, ResizeGuides } from "./resizeGuides";
import { boxBindings, type BoxField } from "./boxBindings";
import { toolChar } from "../input/shortcuts";
import { awaitFaceRows } from "./faceRows";
import type { PressPullFaces } from "../viewport/faceAnalysis";

/** A flat face as a tracked selector so the push follows upstream edits; a curved face keeps its picked point. */
function upToFace(
  hit: { selector: Selector; bodyId: string | null },
  plane: { normal: THREE.Vector3 } | null,
): Selector {
  if (!plane || hit.selector.kind !== "face" || hit.selector.by !== "nearest") return hit.selector;
  const round3 = (x: number) => Math.round(x * 1e3) / 1e3;
  const point = hit.selector.point.map(round3) as Vec3;
  return trackedFace(point, [plane.normal.x, plane.normal.y, plane.normal.z], hit.bodyId);
}

/** Steepest taper the tool offers, degrees, just under the engine's 89 fold limit. */
const MAX_PP_TAPER = 88;
/** A taper needs travel to swing about; under this the arc is not offered. */
const PP_TAPER_MIN = 1;
/** How far above the pushed face the taper arc floats, in pixels. */
const PP_TAPER_ABOVE_PX = 48;
/** A drag or a keystroke waits this long for the value to hold still before the engine is asked. */
const PREVIEW_DEBOUNCE_MS = 150;
/** Under this a push is no push at all, the same floor commit uses. */
const MIN_PUSH = 1e-3;

/** World X projected onto the face plane, or world Y where the face points along X. The taper arc runs along it. */
function inPlaneAxis(normal: THREE.Vector3): THREE.Vector3 {
  const x = new THREE.Vector3(1, 0, 0);
  const u = x.sub(normal.clone().multiplyScalar(x.dot(normal)));
  if (u.lengthSq() < 1e-6) {
    const y = new THREE.Vector3(0, 1, 0);
    return y.sub(normal.clone().multiplyScalar(y.dot(normal))).normalize();
  }
  return u.normalize();
}

type Phase = "pick" | "drag";

type PushRead =
  | { kind: "unreadable" }
  | { kind: "negative" }
  | { kind: "neutral" }
  | { kind: "stay" }
  | { kind: "cancel" }
  | { kind: "ready"; value: number; unverified: boolean; refused: boolean };

const Y_AXIS = HANDLE_UP;

const QUANTITIES: (DimChoice & { id: SizeQuantity })[] = [
  { id: "radius", label: "R", word: "Radius" },
  { id: "diameter", label: "Diameter", icon: "diameter", word: "Diameter" },
  { id: "offset", label: "Offset", word: "Offset" },
];

const CURVED = ["cylinder", "sphere", "cone", "torus"] as const;

const MODES: PressPullMode[] = ["auto", "join", "cut", "new", "intersect"];
const MODE_ICON: Record<PressPullMode, string> = {
  auto: "presspull",
  join: "booleanUnion",
  cut: "booleanSubtract",
  new: "newBody",
  intersect: "booleanIntersect",
};
const MODE_LABEL: Record<PressPullMode, string> = {
  auto: "Auto",
  join: "Join",
  cut: "Cut",
  new: "New",
  intersect: "Intersect",
};

export class PressPullTool {
  active = false;
  private phase: Phase = "pick";
  private faces: Selector[] = []; // one or more faces pushed together by `value`
  private faceIds: number[] = []; // their mesh faceIds (for the instant ghost preview)
  private upTo: Selector | null = null; // "extrude up to this surface" target (else by distance)
  private pickingTarget = false; // waiting for the user to click the up-to target surface
  private releaseRows: (() => void) | null = null;
  private restsOn: string | null = null;
  /** Set by the app (app/carryOn.ts): the next face or edge pick finishes this push and goes on. */
  carry: CarryHost | null = null;
  private releaseCarryRows: (() => void) | null = null;
  private carryLit = false;
  private bodyId: string | null = null;
  private anchor = new THREE.Vector3(); // gizmo origin = the clicked point on the face
  private axis = new THREE.Vector3(0, 0, 1); // drag axis (unit) = face outward normal, or the outward radial on a round face
  private quat = new THREE.Quaternion(); // Y -> current arrow direction
  private value = 0; // signed distance in mm (+ along the axis / out, − in)
  /** A lone cylindrical face or its smooth run: the drag resizes it, `value` is the radial delta, and the readout
   *  is a diameter on a full round, a radius on a partial arc. */
  private round: RoundFace | null = null;
  /** the radius where a tangent neighbour would first be left behind */
  private contact: number | null = null;
  /** The engine's reading of a curved face the mesh fit did not take as a cylinder. */
  private curve: OfferedResize | null = null;
  /** That face as a round face if it reads as a cylinder or sphere along the normal; null on a cone or torus. */
  private curveRound: RoundFace | null = null;
  /** Some selected face is round, so no taper, boolean mode or up to. Outlives `round` when a Ctrl-click adds a
   *  face outside its tangent run. */
  private resizing = false;
  /** What the size field reads for a round face, from its wrap until the user picks. */
  private quantity: SizeQuantity = "diameter";
  private quantityPicked = false;
  /** Tangent faces follow, remembered for the session. */
  private follow = true;
  private toggleKind: "mode" | "follow" | null = null;
  private mode: PressPullMode = "auto";
  /** Along the axis only once the engine says the face has one (`holeAxis`). */
  private direction: PressPullDirection = "normal";
  private holeAxis: HoleAxis | null = null;
  private axisAsk = 0; // bumped per question, so a late answer for another face is dropped
  // Where the arrow stands and points along the normal, restored on switching back.
  private faceAnchor = new THREE.Vector3();
  private faceNormal = new THREE.Vector3(0, 0, 1);
  private lastPointer = { x: 0, y: 0 };
  private previewId = ""; // id shared by the live preview and the committed feature

  private gizmo: THREE.Group | null = null;
  private guides = new ResizeGuides();
  /** the round face's axis and its span along it, the mesh fit's until the engine answers */
  private guideAxis: ResizeAxis | null = null;
  private guideSpan: [number, number] | null = null;
  private roundPoints: Vec3[] = [];
  private handle: DragHandle | null = null;
  private hovering = false;
  private grabbing = false;

  /** Degrees, positive narrows the far end. Only on a planar by-distance push. */
  private taper = 0;
  private taperArc: DragHandle | null = null;
  private taperAxis = new THREE.Vector3(1, 0, 0);
  private taperTop = new THREE.Vector3();
  private taperHovering = false;
  private taperGrabbing = false;
  private taperGrabProj = 0;
  private taperGrabInset = 0;
  /** true while our push is appended to the build as the live preview */
  private enginePreviewOn = false;
  private grabValue = 0; // value at grab start (relative drag)
  private grabProj = 0; // axis projection at grab start
  private downPos = { x: 0, y: 0 };
  private downOnGizmo = false;

  private previewTimer: number | null = null;
  private unsubBuild: (() => void) | null = null;
  private outline: ToolOutline | null = null;
  private rigid: PushFaces | null = null;
  private rowRun = false;
  private unsubTint: (() => void) | null = null;
  /** What the kernel said about each push sent this gesture. */
  private outcomes = new PreviewOutcomes(/^Press\/Pull[^:]*:\s*/i);

  private dim = new DimInput(() => this.store);
  private onDone: ((id: string | null) => void) | null = null;
  private readonly held = new HeldSignal();

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

  /** `opts.grabAt` arms from the pre-selection and starts scrubbing in the passive handle's own pointerdown
   *  (features/faceNudge.ts); both derive the axis from the same selectedFacesForPressPull(). `opts.restsOn` is the
   *  step the picked face came from, so undoing it closes the tool. */
  start(onDone: (id: string | null) => void, opts?: { grabAt?: { x: number; y: number }; restsOn?: string }) {
    if (this.active) return;
    // Read before anything is installed: the direct entry needs the selection its handle was drawn for, or a rebuild
    // in between would arm a pick phase nobody asked for and hold toolBusy().
    const pre = this.viewport.selectedFacesForPressPull();
    if (opts?.grabAt && !pre) return;
    this.restsOn = opts?.restsOn ?? null;
    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.viewport.suspendPicking = true; // we drive our own face picking
    this.gesture.attach();

    if (pre) {
      this.takeFaces(pre);
      if (opts?.grabAt) this.grabHandle(opts.grabAt.x, opts.grabAt.y);
    } else {
      this.releaseRows = awaitFaceRows(
        this.viewport,
        "face",
        (faces) => this.takeRow(faces),
        () => this.cancel(),
        (run) => this.takeRowRun(run),
      );
      setPrompt("Click a face · Ctrl-click adds more");
    }
  }

  private takeFaces(f: PressPullFaces) {
    this.beginDrag(f.selectors, f.faceIds, f.anchor, f.normal, f.bodyId, f.round ?? f.lead);
  }

  private takeRow(f: PressPullFaces): TreePickAnswer {
    if (this.phase !== "drag") return (this.takeFaces(f), true);
    const id = f.faceIds[0]!;
    if (f.bodyId !== this.bodyId) return t("pick.oneBody");
    if (!this.faceIds.includes(id))
      this.addFace({ selector: f.selectors[0]!, faceId: id, anchor: f.anchor, normal: f.normal });
    return true;
  }

  // Rows offered together join one push as Ctrl-clicks would, so the row and carry sessions change hands after the run.
  private takeRowRun(run: () => void) {
    const waiting = this.phase === "pick";
    this.rowRun = waiting;
    try {
      run();
    } finally {
      this.rowRun = false;
      if (waiting && this.active && this.phase === "drag") {
        this.dropRows();
        this.armCarry();
      }
    }
  }

  private dropRows() {
    this.releaseRows?.();
    this.releaseRows = null;
  }

  private beginStopPick() {
    this.releaseCarry();
    this.pickingTarget = true;
    this.dim.hide(); // Enter must not commit a plain distance while picking
    this.clearPreviewTimer();
    // The face to stop at is resolved on the model before the push, so the view and the Geometry rows show that one.
    if (this.enginePreviewOn) this.store.setPreview(null);
    this.enginePreviewOn = false;
    this.viewport.clearPressPullGhost();
    this.outline?.hide();
    setPrompt("Click the face to stop at · Esc");
    this.releaseRows = awaitFaceRows(
      this.viewport,
      "face",
      (faces) => this.takeStop(faces),
      () => this.endStopPick(),
    );
  }

  private endStopPick() {
    this.dropRows();
    this.pickingTarget = false;
    // Restore the distance field T-mode hid; left active it let Enter commit a plain distance mid-pick.
    this.showBox();
    this.refreshPreview(true);
    this.armCarry();
  }

  private takeStop(f: PressPullFaces) {
    const id = f.faceIds[0]!;
    if (this.faceIds.includes(id)) return "That is the face being pushed, pick the face to stop at";
    this.upTo = upToFace({ selector: f.selectors[0]!, bodyId: f.bodyId }, this.viewport.planarFace(id));
    this.commitUpTo();
    return true;
  }

  /** The press landed on the passive selection handle before this tool existed; from here it is the ordinary drag. */
  private grabHandle(clientX: number, clientY: number) {
    if (this.phase !== "drag") return;
    this.grabbing = true;
    this.downOnGizmo = true;
    this.downPos = { x: clientX, y: clientY };
    this.lastPointer = { x: clientX, y: clientY };
    this.grabValue = this.value;
    this.grabProj = axisDragDistance(this.viewport, clientX, clientY, this.anchor, this.axis);
    this.viewport.domElement.style.cursor = "grabbing";
  }

  private onMove(e: PointerEvent) {
    this.lastPointer = { x: e.clientX, y: e.clientY };
    if (this.phase === "pick") {
      const faceId = this.viewport.hoverFaceAt(e.clientX, e.clientY);
      this.viewport.domElement.style.cursor = faceId != null ? "pointer" : "default";
      return;
    }
    if (this.taperGrabbing) {
      // A drag inward against the arc's axis leans the wall by atan(inset / travel), as a draft reads it (draftMath).
      const depth = Math.abs(this.value);
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.taperTop, this.taperAxis);
      const inset = this.taperGrabInset + (this.taperGrabProj - proj);
      const stepped = snap(draftAngle(inset, depth, MAX_PP_TAPER), taperStep(e.shiftKey));
      this.taper = Math.max(-MAX_PP_TAPER, Math.min(MAX_PP_TAPER, stepped));
      this.dim.takeOver("taper");
      this.dim.updateFromCursor({ taper: this.taper });
      this.refreshPreview();
      return;
    }
    if (this.grabbing) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      // Snapped to the zoom's lattice (viewport/dragStep.ts): 0.1mm on a fitted hand-sized part, finer zoomed in or with Shift.
      const raw = this.grabValue + (proj - this.grabProj);
      const stepped = snap(raw, this.viewport.snapStep(this.anchor, e.shiftKey));
      if (stepped === this.value) return; // same step, don't re-trigger an OCCT rebuild
      this.value = stepped;
      this.dim.takeOver("distance");
      this.dim.updateFromCursor({ distance: this.readout() });
      this.refreshPreview();
      return;
    }
    this.taperHovering = this.hitTaper(e.clientX, e.clientY);
    this.hovering = !this.taperHovering && this.hitGizmo(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hovering || this.taperHovering ? "grab" : "default";
    this.lightCarry(e.clientX, e.clientY, this.hovering || this.taperHovering);
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (!hit) return; // missed the body, let the click orbit
      e.preventDefault();
      e.stopImmediatePropagation();
      this.beginDrag(
        [hit.selector],
        [hit.faceId],
        hit.anchor,
        hit.normal,
        hit.bodyId,
        this.viewport.roundFaceAt(hit.faceId, hit.anchor),
      );
      return;
    }
    // Picking the up-to target consumes every click, so a miss never falls through to a stray commit.
    if (this.pickingTarget) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (hit && !this.faceIds.includes(hit.faceId)) {
        this.upTo = upToFace(hit, this.viewport.planarFace(hit.faceId));
        this.commitUpTo();
      } else {
        setPrompt("Click the face to stop at · Esc");
      }
      return;
    }
    // Ctrl/Cmd-click adds a face on the same body, sharing the one distance; checked before the grab.
    if (e.ctrlKey || e.metaKey) {
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (hit && hit.bodyId === this.bodyId) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.addFace(hit);
      }
      return;
    }
    // The taper arc is tested first since it floats above the push handle, and setting the lean never commits.
    if (this.hitTaper(e.clientX, e.clientY)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.taperGrabbing = true;
      this.downPos = { x: e.clientX, y: e.clientY };
      this.taperGrabInset = draftDelta(this.taper, Math.abs(this.value), MAX_PP_TAPER);
      this.taperGrabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.taperTop, this.taperAxis);
      this.viewport.domElement.style.cursor = "grabbing";
      return;
    }
    this.downPos = { x: e.clientX, y: e.clientY };
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.downOnGizmo = this.hitGizmo(e.clientX, e.clientY);
    if (this.downOnGizmo) {
      e.preventDefault();
      e.stopImmediatePropagation(); // don't let the camera orbit while dragging the handle
      this.grabbing = true;
      this.grabValue = this.value;
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      this.viewport.domElement.style.cursor = "grabbing";
    }
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0 || this.phase !== "drag") return;
    if (this.pickingTarget) return; // T-mode clicks are fully handled in onDown
    // Letting go of a handle only ends the drag: the box options and Enter are still to come.
    if (this.taperGrabbing) {
      this.taperGrabbing = false;
      this.viewport.domElement.style.cursor = this.taperHovering ? "grab" : "default";
      this.dim.focus();
      this.held.sync(this.pending);
      return;
    }
    if (this.grabbing) {
      this.grabbing = false;
      this.flushPreviewNow();
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      this.dim.focus();
      this.held.sync(this.pending);
      return;
    }
    const moved = Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (this.downOnGizmo || moved) return;
    // A clean click on another face or an edge finishes the push and goes on from there, T is the way to stop at a
    // face; empty space or one of its own faces just commits.
    const hit = this.carriesOn() ? pickOfHit(this.viewport.pickEntity(e.clientX, e.clientY)) : null;
    const own = hit?.kind === "face" && this.faceIds.includes(hit.faceId);
    if (hit && !own && this.carry!.route(hit) !== "row") return;
    this.commit();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (this.pickingTarget) {
        this.endStopPick();
        return;
      }
      this.cancel();
      return;
    }
    if (
      toolChar(e) === "t" &&
      !this.dim.typesText(e) &&
      this.phase === "drag" &&
      !this.pickingTarget &&
      !this.resizing
    ) {
      this.beginStopPick();
    }
  }

  private addFace(hit: { selector: Selector; faceId: number; anchor: THREE.Vector3; normal: THREE.Vector3 }) {
    const was = this.boxShape();
    const curved = this.curve !== null;
    const before = this.faceNormal.clone();
    this.faces.push(hit.selector);
    this.faceIds.push(hit.faceId);
    // The faces share one arrow from here, and the engine's answer about the first face's axis no longer applies.
    this.axisAsk++;
    this.holeAxis = null;
    this.curve = null;
    this.curveRound = null;
    this.dim.setOptionHidden("direction", true);
    if (this.direction === "axis") this.setDirection("normal");
    if (curved || this.viewport.roundFaceAt(hit.faceId, hit.anchor)) this.resizing = true;
    if (this.round && !this.inTangentRun()) this.dropRound();
    if (this.resizing) {
      this.mode = "auto";
      this.taper = 0;
    } else {
      // The arrow moves to the face just picked: the drag is measured along it, each face moves along its own.
      this.anchor.copy(hit.anchor);
      this.faceAnchor.copy(hit.anchor);
      this.faceNormal.copy(hit.normal).normalize();
      this.axis.copy(this.faceNormal);
    }
    // The model on screen may be a landed preview with the earlier faces moved, so only the new face is read off it.
    const added = this.resizing || !this.rigid ? null : planarPushFaces(this.viewport, [hit.faceId], before);
    this.rigid = added &&
      this.rigid && { rings: [...this.rigid.rings, ...added.rings], marks: [...this.rigid.marks, ...added.marks] };
    if (was !== this.boxShape()) this.showBox();
    else this.syncToggle();
    this.refreshPreview(true);
  }

  private beginDrag(
    faces: Selector[],
    faceIds: number[],
    anchor: THREE.Vector3,
    normal: THREE.Vector3,
    bodyId: string | null = null,
    round: RoundFace | null = null,
  ) {
    if (!this.rowRun) {
      this.dropRows();
      this.armCarry();
    }
    this.faces = faces;
    this.faceIds = faceIds;
    this.upTo = null;
    this.pickingTarget = false;
    this.bodyId = bodyId;
    this.round = round;
    this.contact = null;
    this.curve = null;
    this.curveRound = null;
    this.quantity = defaultQuantity(round?.full !== false);
    this.quantityPicked = false;
    this.resizing =
      round !== null || (faceIds.length > 1 && faceIds.some((id) => this.viewport.roundFaceAt(id, anchor) !== null));
    this.anchor.copy(anchor);
    this.axis.copy(round?.radial ?? normal).normalize();
    this.faceAnchor.copy(anchor);
    this.faceNormal.copy(normal).normalize();
    this.seedGuides(round, faceIds[0]);
    this.rigid = this.resizing ? null : planarPushFaces(this.viewport, faceIds, this.faceNormal);
    this.direction = "normal";
    this.holeAxis = null;
    this.phase = "drag";
    this.value = 0;
    this.taper = 0;
    this.previewId = this.store.nextId();
    this.outcomes.forget();
    this.viewport.clearHover();
    this.buildGizmo();
    this.mode = "auto";
    this.showBox();
    const lone = faces[0];
    if (lone && (faces.length === 1 || round)) this.askAxis(lone, bodyId);
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    this.unsubBuild ??= this.store.onBuild((st) => {
      if (st.building || !st.result || this.phase !== "drag") return;
      this.noteBuildOutcome(st);
    });
    this.unsubTint ??= this.tintAfterPreview();
    this.promptNow();
    this.gesture.frame();
  }

  /** The ∠ taper field rides beside the distance only for a sliding push; a resize offers Tangent faces follow
   *  instead of the boolean mode. */
  private showBox() {
    const defs: DimFieldDef[] = [
      {
        name: "distance",
        ...this.fieldLabel(),
        kind: "length",
        step: (fine) => gizmoMoveStep(this.viewport.pixelWorldSize(this.anchor), fine),
        ...(this.round ? { choices: this.quantityChoices() } : {}),
      },
    ];
    if (!this.resizing) defs.push({ name: "taper", label: "Angle", icon: "angle", kind: "angle", step: taperStep });
    this.toggleKind = !this.resizing ? "mode" : this.round ? "follow" : null;
    const options: DimOption[] = [
      ...(this.toggleKind === "mode" ? [this.modeOption()] : this.toggleKind === "follow" ? [this.followToggle()] : []),
      this.directionOption(),
    ];
    this.dim.show(
      defs,
      () => this.commit(),
      () => this.cancel(),
      options,
      undefined,
      () => this.onTyped(),
    );
    this.dim.restoresOnUndo(
      "distance",
      () => this.value,
      (value) => {
        this.value = value;
        this.refreshPreview();
      },
    );
    this.dim.restoresOnUndo(
      "taper",
      () => this.taper,
      (taper) => {
        this.taper = taper;
        this.refreshPreview();
      },
    );
    this.dim.setOptionHidden("direction", !this.holeAxis);
    this.syncToggle();
    // A round face opens at the size it already is, the number to edit; a flat face opens at 0, a travel.
    this.dim.updateFromCursor({ distance: this.readout(), ...(this.resizing ? {} : { taper: this.taper }) });
  }

  private get full(): boolean {
    return this.round?.full !== false;
  }

  private fieldLabel(): { label: string; icon?: string } {
    if (!this.round) return { label: this.slant ? "Offset" : "D" };
    const { label, icon } = QUANTITIES.find((q) => q.id === this.quantity)!;
    return icon ? { label, icon } : { label };
  }

  /** R, ⌀ or Offset on the field's name, also picked by typing r2.5, ⌀5 or +0.5. */
  private quantityChoices(): DimChoices {
    return {
      options: QUANTITIES,
      chosen: this.quantity,
      read: (raw) => {
        const got = parseSizeText(raw);
        return got && { choice: got.quantity, text: got.text };
      },
      onChoose: (id, typed) => this.chooseQuantity(id as SizeQuantity, typed),
    };
  }

  /** A pick from the menu shows the same size in the new terms; a typed one leaves the text alone. */
  private chooseQuantity(q: SizeQuantity, typed: boolean) {
    this.quantityPicked = true;
    const held = !typed && this.dim.isUserDriven("distance");
    if (held) {
      const v = this.dim.getValue("distance");
      if (v != null && !(this.absolute && v < 0)) this.value = this.fromReadout(v);
    }
    this.quantity = q;
    if (!typed) {
      if (held) this.dim.seed("distance", this.readout());
      else this.dim.updateFromCursor({ distance: this.readout() });
    }
    this.promptNow();
  }

  /** The field reads a size rather than how far the face moves. */
  private get absolute(): boolean {
    return !!this.round && isAbsolute(this.quantity);
  }

  /** The size a round face would become as a radius or diameter (0 while asking for a full one to go), else the
   *  distance travelled. */
  private readout(): number {
    const r = this.round;
    if (!r) return this.slant ? this.value : Math.abs(this.value);
    return sizeReadout(this.quantity, r.radius, this.value, r.solidInside, this.full);
  }

  /** The inverse: a number the user TYPED into that field, read back as a drag. */
  private fromReadout(v: number): number {
    const r = this.round;
    if (!r) return v;
    return deltaForSize(this.quantity, r.radius, v);
  }

  private negativeSize(): string {
    return `a ${this.quantity} can't be negative`;
  }

  /** Typing a size is absolute, so a minus sign is a mistake to say at once. */
  private onTyped() {
    if (this.absolute) {
      const v = this.dim.getValue("distance");
      if (v != null && v < 0) this.dim.flag(this.negativeSize());
    }
    this.promptNow();
  }

  /** A minus on a size, or not yet a number; the drag value behind it is stale then. */
  private typedUnusable(): { reason: string | null } | null {
    if (!this.dim.isUserDriven("distance")) return null;
    const v = this.dim.getValue("distance");
    if (v == null) return { reason: null };
    return this.absolute && v < 0 ? { reason: this.negativeSize() } : null;
  }

  /** Keeps a typed value previewing while the pointer is still. The handle rides on the face where it is now; the
   *  drag is still measured from `anchor`. */
  private tick() {
    if (this.phase === "drag" && this.gizmo) {
      const sign = this.value < 0 ? -1 : 1;
      const dir = this.axis.clone().multiplyScalar(sign);
      this.quat.setFromUnitVectors(Y_AXIS, dir);
      const at = this.anchor.clone().addScaledVector(this.axis, this.value);
      const k = this.viewport.pixelWorldSize(at);
      this.gizmo.position.copy(at);
      this.gizmo.quaternion.copy(this.quat);
      this.gizmo.scale.setScalar(k);
      // Tone tracks the DIRECTION of the push: amber adds material, red cuts.
      this.handle?.paint({
        hot: this.hovering || this.grabbing,
        tone: sign < 0 ? "cut" : "idle",
        refused: this.outcomes.refusal !== null,
      });
      this.placeTaperArc(dir, k);
      this.placeGuides(at);
      const s = this.viewport.projectToScreen(at);
      const tip = this.viewport.projectToScreen(at.clone().addScaledVector(dir, k * HANDLE_LENGTH));
      this.dim.positionPast(tip, { x: tip.x - s.x, y: tip.y - s.y }, this.viewport.domElement.getBoundingClientRect());
      if (!this.grabbing && this.dim.isUserDriven("distance")) {
        const v = this.dim.getValue("distance");
        if (v != null && !(this.absolute && v < 0)) {
          // The field is the truth, typed sign included (out = +, cut = −).
          const want = this.fromReadout(v);
          if (Math.abs(want - this.value) > 1e-6) {
            this.value = want;
            this.refreshPreview();
          }
        }
      }
      if (!this.taperGrabbing && this.dim.isUserDriven("taper")) {
        const tv = this.dim.getValue("taper");
        if (tv != null) {
          const want = Math.max(-MAX_PP_TAPER, Math.min(MAX_PP_TAPER, tv));
          if (Math.abs(want - this.taper) > 1e-6) {
            this.taper = want;
            this.refreshPreview();
          }
        }
      }
      this.held.sync(this.pending);
      this.gesture.frame();
    }
  }

  /** The axis line and the dashed size line of a round face resize. */
  private placeGuides(handle: THREE.Vector3) {
    const axis = this.guideAxis;
    const span = this.guideSpan;
    if (!this.round || !axis || !span || this.removing || this.pickingTarget) {
      this.guides.clear();
      return;
    }
    this.guides.update(this.viewport, { axis, span, handle, full: this.full });
  }

  /** The guides stand on the picked face's mesh until the engine gives its exact axis. */
  private seedGuides(round: RoundFace | null, faceId: number | undefined) {
    this.roundPoints = [];
    this.guideAxis = null;
    this.guideSpan = null;
    if (!round || faceId === undefined) return;
    if (round.centre) {
      // A sphere has no axis to draw, only the size line out from its centre.
      this.guideAxis = { origin: round.cylinder.point, dir: round.cylinder.axis };
      this.guideSpan = [0, 0];
      return;
    }
    for (const t of this.viewport.faceTriangles(faceId)) {
      for (const v of [t.a, t.b, t.c]) this.roundPoints.push([v.x, v.y, v.z]);
    }
    this.setGuideAxis({ origin: round.cylinder.point, dir: round.cylinder.axis });
  }

  private setGuideAxis(axis: ResizeAxis) {
    this.guideAxis = axis;
    this.guideSpan = axialSpan(this.roundPoints, axis);
  }

  /** The value as the feature stores it. */
  private size(): number {
    return Math.round(this.value * 1000) / 1000;
  }

  /** Nothing to push: the drag sits on the face, and is not removing it. */
  private get neutral(): boolean {
    return Math.abs(this.value) < MIN_PUSH && !this.removing;
  }

  private get removing(): boolean {
    const r = this.round;
    return !!r && radialDrag(r.radius, this.value, r.solidInside, this.full).mode === "remove";
  }

  /** The drag value a sent feature was built from. */
  private valueOf(f: Feature): number | null {
    const r = this.round;
    if (f.type === "deleteFace") return r ? -r.radius : null;
    if (f.type !== "press-pull" || typeof f.distance !== "number") return null;
    return r ? (r.solidInside ? f.distance : -f.distance) : f.distance;
  }

  /** The value the model on screen was built at for the current question, or null. */
  private get shown(): number | null {
    const f = this.outcomes.shownFor(this.buildFeature(), ["type", "distance", "operation"]);
    return f ? this.valueOf(f) : null;
  }

  private noteBuildOutcome(s: RebuildState) {
    this.outcomes.note(s, this.previewId);
    this.refreshGhost();
    this.refreshRefusal();
  }

  /** Paint the refusal, or take it down, on the handle, the value box and the prompt. */
  private refreshRefusal() {
    const k = this.neutral || this.pickingTarget ? null : featureKey(this.buildFeature());
    if (!this.outcomes.refresh(k)) return;
    const reason = this.outcomes.refusal;
    this.dim.showOwnProblem(reason);
    this.handle?.paint({ refused: reason !== null });
    this.viewport.requestRender();
    this.promptNow();
  }

  /** The instant cap of a resize, cone or torus offset until the engine's preview shows. Only over the model it
   *  was picked on: a preview renumbers the faces. */
  private refreshGhost() {
    const r = this.round;
    // A whole run moves each face along its own normal, a wall included, by the kernel's push.
    const run = !!r && this.faces.length > 1;
    const along = run || (!r && this.slant) ? "normal" : r;
    const k = this.neutral ? null : featureKey(this.buildFeature());
    if (
      !along ||
      this.pickingTarget ||
      this.outcomes.shownFeature ||
      this.removing ||
      k === null ||
      this.outcomes.isRefused(k)
    ) {
      this.viewport.clearPressPullGhost();
      return;
    }
    const push = run ? radialDrag(r.radius, this.value, r.solidInside, this.full).distance : this.value;
    this.viewport.setPressPullGhost(this.faceIds, push, along);
  }

  /** How many faces Tangent faces follow moves at this size, 0 when it does not engage. */
  private followMoves(): number {
    const r = this.round;
    const t = r?.tangent;
    if (!r || !t || !this.followOffered() || !this.follow || !t.lostWhen || !t.followable) return 0;
    const next = r.radius + this.value;
    const contact = this.contact ?? r.radius;
    const lost = t.lostWhen === "shrink" ? next < contact - 1e-6 : next > contact + 1e-6;
    return lost ? Math.max(1, t.run.length - 1, t.faces) : 0;
  }

  /** A size for the prompt, said the way the field reads it. */
  private sizeText(value: number): string {
    const r = this.round;
    const signed = `${value < 0 ? "-" : "+"}${fmtLength(Math.abs(value))}`;
    if (!r) return this.slant ? signed : fmtLength(Math.abs(value));
    const d = radialDrag(r.radius, value, r.solidInside, this.full);
    if (d.mode === "remove") return "it removed";
    if (this.quantity === "offset") return signed;
    return this.quantity === "diameter" ? `⌀${fmtLength(d.diameter)}` : `R${fmtLength(d.radius)}`;
  }

  /** Where a full round stops resizing and goes, said the way the field reads it. */
  private removalText(r: RoundFace): string {
    const at = r.radius * COLLAPSE_FRACTION;
    if (this.quantity === "offset") return `below ${fmtLength(at - r.radius)}`;
    return this.quantity === "diameter" ? `under ⌀${fmtLength(2 * at)}` : `under R${fmtLength(at)}`;
  }

  private promptNow() {
    if (this.phase !== "drag" || this.pickingTarget) return;
    const r = this.round;
    if (this.outcomes.refusal) {
      const shown = this.shown;
      const then = this.dim.isUserDriven("distance")
        ? `type another ${r ? this.quantity : "distance"}`
        : shown !== null && Math.abs(shown) >= MIN_PUSH
          ? `keeping ${this.sizeText(shown)}`
          : "drag back";
      setPrompt(`Refused, ${then} · Esc`);
      return;
    }
    if (r) {
      const ask = this.quantity === "offset" ? "how far it moves, + is bigger" : `a ${this.quantity}`;
      const unusable = this.typedUnusable();
      if (unusable) {
        const why = unusable.reason;
        return setPrompt(
          why ? `${why[0]!.toUpperCase()}${why.slice(1)} · type another ${this.quantity} · Esc` : `Type ${ask} · Esc`,
        );
      }
      // Nothing to ghost once the drag asks for the face to go; the readout dropping to 0 and this line say so.
      if (this.removing) return setPrompt("Enter removes this face · drag back to keep it · Esc");
      const moves = this.followMoves();
      if (moves > 0) {
        return setPrompt(
          `Moves the ${moves === 1 ? "face that runs" : `${moves} faces that run`} smoothly into it · Esc`,
        );
      }
      return setPrompt(
        this.full
          ? `Drag or type ${ask} · Up or Down steps · ${this.removalText(r)} removes it · Esc`
          : `Drag or type ${ask} · Up or Down steps · Esc`,
      );
    }
    if (this.slant) return setPrompt("Drag or type how far it moves, negative cuts · Up or Down steps · Esc");
    const on = this.carry ? ` · click to commit · ${carryWords.prompt()}` : " · click to commit";
    if (this.faces.length > 1) {
      return setPrompt(
        `${this.faces.length} faces · drag or type a distance · Up or Down steps · T stops at a face${on} · Esc`,
      );
    }
    setPrompt(`Drag or type a value, negative cuts · Up or Down steps · T stops at a face${on} · Esc`);
  }

  /** Through the engine for every push, since neighbours slope and re-trim in ways no ghost can draw. `hold` keeps
   *  the last push that built while the kernel refuses this one; `now` skips the debounce. */
  private refreshPreview(now = false) {
    this.refreshOutline();
    this.refreshGhost();
    this.refreshRefusal();
    this.promptNow();
    this.clearPreviewTimer();
    if (now) {
      this.pushPreview();
      return;
    }
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      this.pushPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private pushPreview() {
    if (!this.active || this.phase !== "drag" || this.pickingTarget) return;
    if (this.neutral) {
      if (this.enginePreviewOn) this.store.setPreview(null);
      this.enginePreviewOn = false;
      this.refreshRefusal();
      return;
    }
    const f = this.buildFeature();
    // A push already refused is not asked again; the model keeps the last one that built.
    if (!this.outcomes.isRefused(featureKey(f))) {
      this.store.setPreview(f, { hold: true });
      this.enginePreviewOn = true;
    }
    this.refreshRefusal();
  }

  /** Ask the engine right away when a debounce is pending. */
  private flushPreviewNow() {
    if (this.previewTimer == null) return;
    this.clearPreviewTimer();
    this.pushPreview();
  }

  private clearPreviewTimer() {
    if (this.previewTimer == null) return;
    window.clearTimeout(this.previewTimer);
    this.previewTimer = null;
  }

  /** The volume a rigid push of flat faces adds or takes away, over the engine's opaque body. */
  private refreshOutline() {
    const rigid = this.rigid;
    const depth = Math.abs(this.value);
    const along = this.axis.dot(this.faceNormal);
    if (
      !rigid ||
      this.pickingTarget ||
      this.upTo ||
      this.resizing ||
      this.neutral ||
      Math.abs(this.taper) >= 0.05 ||
      Math.abs(along) < PARALLEL_COS
    ) {
      this.outline?.hide();
      return;
    }
    const n = this.faceNormal;
    const dir = this.axis.clone().multiplyScalar(Math.sign(this.value));
    const polylines = sweepPolylines({
      rings: rigid.rings,
      normal: [n.x, n.y, n.z],
      axis: [dir.x, dir.y, dir.z],
      stations: [
        { along: 0, inset: 0 },
        { along: depth, inset: 0 },
      ],
    });
    this.outline ??= new ToolOutline(this.viewport);
    this.outline.show(polylines, { cut: this.mode === "cut" || (this.mode === "auto" && this.value < 0) });
  }

  // A selection rides a rebuild by each face's old centroid, so the pushed faces are found again after each preview,
  // where the last good model put them when the push was refused.
  private tintAfterPreview(): () => void {
    let started = false;
    let shown: number | null = null;
    // The store replays its current state on subscribing, only a build seen starting is ours to read
    return this.store.onSessionBuild((s) => {
      if (s.building) {
        started = true;
        return;
      }
      if (!started || !s.result) return;
      const sent = s.previewBuilt?.find((f) => f.id === this.previewId);
      const marks = this.rigid?.marks;
      if (!sent || sent.type !== "press-pull" || !marks || this.phase !== "drag") return;
      started = false;
      if (!s.heldRefusal) shown = sent.distance as number;
      if (shown == null) return;
      const by = this.axis.clone().multiplyScalar(shown);
      const onBody = this.bodyId ?? undefined;
      const found = marks.flatMap((m) => {
        const id = this.viewport.faceIdNear([m.x + by.x, m.y + by.y, m.z + by.z], 0, onBody);
        return id == null ? [] : [id];
      });
      if (found.length) this.viewport.selectOnlyFaces(found);
    });
  }

  private buildGizmo() {
    this.handle = nameHandle(createDragHandle(), "push");
    this.gizmo = this.handle.group;
    this.viewport.addToScene(this.gizmo);
  }

  private hitGizmo(x: number, y: number): boolean {
    return this.handleAt(x, y) === "push";
  }

  /** Taper arc first, as the press tests them; one probe for both so a finger takes the handle under the touch. */
  private handleAt(x: number, y: number): "taper" | "push" | null {
    const arc = this.taperArc;
    const gizmo = this.gizmo;
    if (!arc && !gizmo) return null;
    return this.viewport.probe(x, y, (rc) =>
      arc && rc.intersectObjects(arc.group.children, false).length > 0
        ? "taper"
        : gizmo && rc.intersectObjects(gizmo.children, false).length > 0
          ? "push"
          : null,
    );
  }

  /** Only where a wall exists to lean: a sliding by-distance push with real travel. */
  private canTaper(): boolean {
    return (
      !this.resizing &&
      !this.upTo &&
      !this.pickingTarget &&
      this.direction === "normal" &&
      Math.abs(this.value) >= PP_TAPER_MIN
    );
  }

  /** Floats the taper arc above the pushed face in the plane the wall tips through, as the extrude tool does. */
  private placeTaperArc(dir: THREE.Vector3, k: number) {
    if (!this.canTaper()) {
      this.disposeTaperArc();
      return;
    }
    if (!this.taperArc) {
      this.taperArc = nameHandle(createRotationArc(), "taper");
      this.viewport.addToScene(this.taperArc.group);
    }
    this.taperAxis.copy(inPlaneAxis(this.axis));
    this.taperTop.copy(this.anchor).addScaledVector(dir, Math.abs(this.value));
    const g = this.taperArc.group;
    g.position.copy(this.taperTop).addScaledVector(dir, k * PP_TAPER_ABOVE_PX);
    const z = new THREE.Vector3().crossVectors(this.taperAxis, dir).normalize();
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(this.taperAxis, dir, z));
    g.scale.setScalar(k);
    this.taperArc.paint({
      hot: this.taperHovering || this.taperGrabbing,
      tone: this.taper < 0 ? "cut" : "idle",
    });
  }

  private hitTaper(x: number, y: number): boolean {
    return this.handleAt(x, y) === "taper";
  }

  private disposeTaperArc() {
    if (!this.taperArc) return;
    this.viewport.removeFromScene(this.taperArc.group);
    this.taperArc.dispose();
    this.taperArc = null;
  }

  private modeOption(): DimSegmentedDef {
    return {
      name: "mode",
      title:
        "Auto grows or shrinks the face; Join, Cut, New body and Intersect extrude it and combine with any body it reaches",
      segments: MODES.map((m) => ({ id: m, label: MODE_LABEL[m], icon: MODE_ICON[m] })),
      chosen: this.mode,
      onChoose: (id) => {
        this.mode = id as PressPullMode;
        this.refreshPreview(true);
      },
    };
  }

  private followToggle(): DimToggleDef {
    return {
      label: "Tangent faces follow",
      icon: "tangent",
      title:
        "On, the faces that run smoothly into this one move with it once it is too small or too big for them to meet it, so a slot narrows as one; off, that size is refused",
      initial: this.follow,
      onChange: (on) => {
        this.follow = on;
        this.refreshPreview(true);
      },
    };
  }

  /** Tangent faces follow applies to one round face with faces running into it. */
  private followOffered(): boolean {
    return this.faces.length === 1 && (this.round?.tangent?.faces ?? 0) > 0;
  }

  private syncToggle() {
    if (this.toggleKind === "follow") this.dim.setToggleHidden(!this.followOffered());
  }

  /** Every selected face lies in the first round face's tangent run, a whole slot picked face by face. */
  private inTangentRun(): boolean {
    const run = this.round?.tangent?.run;
    if (!run?.length) return false;
    const ids = new Set(run.map((p) => this.viewport.faceIdNear(p)));
    return this.faceIds.every((id) => ids.has(id));
  }

  /** Reads the drag as a signed push along the first face's outward normal, the arrow kept in place. */
  private dropRound() {
    const r = this.round;
    if (!r) return;
    const out = r.solidInside ? 1 : -1;
    this.value *= out;
    this.grabValue *= out;
    this.axis.copy(r.radial).multiplyScalar(out).normalize();
    this.faceNormal.copy(this.axis);
    this.round = null;
    this.contact = null;
  }

  /** Several faces that turned out not to be one round face's run push as one. */
  private leaveRun() {
    const was = this.boxShape();
    this.dropRound();
    if (was !== this.boxShape()) this.showBox();
    this.refreshPreview(true);
  }

  /** Hidden until the engine says the face has an axis; a fresh one per showing of the box. */
  private directionOption(): DimSegmentedDef {
    return {
      name: "direction",
      title:
        "Along axis slides the end of a hole down the hole, so the hole gets deeper and its end keeps its shape; Along normal offsets the face",
      segments: [
        { id: "normal", label: DIRECTION_LABEL.normal, icon: "offsetFace" },
        { id: "axis", label: DIRECTION_LABEL.axis, icon: "datumAxis" },
      ],
      chosen: this.direction,
      onChoose: (id) => this.setDirection(id as PressPullDirection),
    };
  }

  private askAxis(face: Selector, bodyId: string | null) {
    const ask = ++this.axisAsk;
    void this.store.faceAxis(face, bodyId).then((reply) => {
      if (ask !== this.axisAsk || !this.active || this.phase !== "drag") return;
      const r = offeredResize(reply, CURVED);
      if (this.round && r?.kind === "cylinder") return this.adoptResize(r, resizeAxis(reply));
      if (this.faces.length > 1) return this.leaveRun();
      if (r && this.adoptCurve(r, reply)) return;
      if (this.round) return;
      this.holeAxis = offeredAxis(reply);
      if (!this.holeAxis) return;
      this.dim.setOptionHidden("direction", false);
      if (initialDirection(this.holeAxis) === "axis") this.setDirection("axis");
    });
  }

  /** The engine's exact size, wrap and tangent run replace the mesh's guess. */
  private adoptResize(r: OfferedResize | null, axis: ResizeAxis | null) {
    const round = this.round;
    if (!round || !r) return;
    if (axis) this.setGuideAxis(axis);
    this.round = { ...round, radius: r.radius, full: r.full, solidInside: !r.concave, tangent: r.tangent };
    this.contact = r.contact;
    if (this.faces.length > 1 && !this.inTangentRun()) return this.leaveRun();
    if (!this.quantityPicked) this.quantity = defaultQuantity(r.full);
    this.dim.setChoice("distance", this.quantity);
    this.dim.updateFromCursor({ distance: this.readout() });
    this.syncToggle();
    if (this.neutral) this.promptNow();
    else this.refreshPreview(true);
  }

  /** A face the mesh did not fit as a cylinder, read from the engine. False when there is nothing to read. */
  private adoptCurve(r: OfferedResize, reply: FaceAxisReply | null): boolean {
    const was = this.boxShape();
    const at = this.faceAnchor;
    const round = roundFromResize(r, resizeAxis(reply), [at.x, at.y, at.z]);
    const normal = round ? round.radial : facetNormalAt(this.viewport.faceTriangles(this.faceIds[0] ?? -1), at);
    if (!normal || (r.kind === "cylinder" || r.kind === "sphere") !== (round !== null)) return false;
    this.curve = r;
    this.curveRound = round;
    this.round = null;
    this.faceNormal.copy(normal).normalize();
    this.contact = r.contact;
    if (!this.quantityPicked) this.quantity = defaultQuantity(r.full);
    // A round end of a hole still slides down it; a cylinder never did.
    this.holeAxis = r.kind === "cylinder" ? null : offeredAxis(reply);
    this.dim.setOptionHidden("direction", !this.holeAxis);
    this.setDirection(initialDirection(this.holeAxis), was);
    return true;
  }

  /** Along the normal a sphere resizes about its centre and a cone or torus offsets; along a hole's axis it slides. */
  private applyCurve() {
    if (!this.curve) return;
    const along = this.direction === "normal";
    const round = along ? this.curveRound : null;
    if (round !== this.round) this.seedGuides(round, this.faceIds[0]);
    this.round = round;
    this.resizing = along;
    if (along) {
      this.mode = "auto";
      this.taper = 0;
    }
  }

  /** A cone or torus has no one size to read, so the field says how far it moves. */
  private get slant(): boolean {
    const k = this.curve?.kind;
    return (k === "cone" || k === "torus") && this.faces.length === 1 && this.direction === "normal";
  }

  /** What decides the fields and the switch the value box shows. */
  private boxShape(): string {
    return `${this.resizing} ${this.round !== null} ${this.slant}`;
  }

  private setDirection(d: PressPullDirection, was = this.boxShape()) {
    const axis = this.holeAxis;
    this.direction = d === "axis" && axis ? "axis" : "normal";
    this.applyCurve();
    if (this.boxShape() !== was) {
      // A size and a slide are different numbers, so the drag starts over.
      this.value = 0;
      this.showBox();
    }
    this.dim.setOption("direction", this.direction);
    this.dim.setFieldHidden("taper", this.direction === "axis");
    if (this.direction === "axis" && axis) {
      const [x, y, z] = anchorOnAxis([this.faceAnchor.x, this.faceAnchor.y, this.faceAnchor.z], axis);
      this.anchor.set(x, y, z);
      this.axis.set(axis.dir[0], axis.dir[1], axis.dir[2]);
    } else {
      this.anchor.copy(this.faceAnchor);
      this.axis.copy(this.faceNormal);
    }
    // A switch mid-drag must not jump the value: measure on from here along the new arrow.
    if (this.grabbing) {
      this.grabValue = this.value;
      this.grabProj = axisDragDistance(this.viewport, this.lastPointer.x, this.lastPointer.y, this.anchor, this.axis);
    }
    this.refreshPreview(true);
  }

  private buildFeature(): Feature {
    const face = this.faces.length === 1 ? (this.faces[0] ?? this.faces) : this.faces;
    // Past the smallest size the kernel builds, a round face is removed as the same deleteFace Del produces, so it heals
    // like a deleted one. Nothing is committed before this, which lets the user drag back out of it.
    const round = this.round && radialDrag(this.round.radius, this.value, this.round.solidInside, this.full);
    if (round?.mode === "remove") {
      return {
        id: this.previewId,
        type: "deleteFace",
        face,
        ...(this.bodyId != null ? { body: this.bodyId } : {}),
      } as Feature;
    }
    const v = Math.round((round ? round.distance : this.value) * 1000) / 1000;
    return {
      id: this.previewId,
      type: "press-pull",
      face,
      distance: v,
      operation: v >= 0 ? "join" : "cut",
      ...(this.mode !== "auto" && !this.resizing ? { mode: this.mode } : {}),
      ...(this.direction === "axis" && !this.round ? { direction: "axis" as const } : {}),
      ...(this.followOffered() ? { followTangent: this.follow } : {}),
      ...(this.bodyId != null ? { body: this.bodyId } : {}),
      ...(this.upTo ? { upTo: this.upTo } : {}),
      // Taper only on a planar by-distance push, written only when it bites.
      ...(!this.resizing && !this.upTo && this.direction === "normal" && Math.abs(this.taper) >= 0.05
        ? { taper: Math.round(this.taper * 1000) / 1000 }
        : {}),
    };
  }

  /** The box and the preview's answer read as Enter would act on them. Reading may start the push the debounce held. */
  private readCommit(): PushRead {
    const v = this.dim.getValue("distance");
    const typed = this.dim.isUserDriven("distance");
    // Committing the stale drag value instead of unreadable text would be a silent wrong number.
    if (v == null && typed) return { kind: "unreadable" };
    if (typed && v != null && this.absolute && v < 0) return { kind: "negative" };
    // A typed ∠ is the truth for the taper, the same rule the distance follows.
    const tv = this.dim.getValue("taper");
    if (tv != null && this.dim.isUserDriven("taper")) {
      this.taper = Math.max(-MAX_PP_TAPER, Math.min(MAX_PP_TAPER, tv));
    }
    // Typed sign only when the user typed: while dragging the field shows |value|, and reading it back turns a cut into a join.
    const want = typed && v != null ? this.fromReadout(v) : this.value;
    if (Math.abs(want - this.value) > 1e-6) {
      this.value = want;
      this.refreshPreview(true);
    } else {
      this.flushPreviewNow();
    }
    if (this.neutral) return { kind: "neutral" };
    const k = featureKey(this.buildFeature());
    const verdict = this.outcomes.verdict(k);
    const decision = commitDecision({
      value: this.size(),
      verdict,
      settled: this.outcomes.settled(k),
      shown: this.shown,
      typed,
      meaningful: (x) => Math.abs(x) >= MIN_PUSH,
    });
    if (decision.action !== "commit") return { kind: decision.action };
    return { kind: "ready", value: decision.value, unverified: !!decision.unverified, refused: verdict === "refused" };
  }

  private commit() {
    if (this.phase !== "drag") return this.cancel();
    const read = this.readCommit();
    if (read.kind === "unreadable") return setPrompt("That number can't be read · Esc");
    if (read.kind === "negative") return void this.dim.flag(this.negativeSize());
    if (read.kind === "neutral") {
      // keep the tool alive: silently cancelling here read as "nothing happened"
      return setPrompt(
        this.round
          ? `The ${this.quantity === "offset" ? "size" : this.quantity} is unchanged`
          : "Nothing to commit yet",
      );
    }
    if (read.kind === "stay") return this.promptNow();
    if (read.kind === "cancel") return this.cancel();
    const { id, reselect } = this.write(read);
    if (reselect) this.reselectAfterBuild(id, reselect);
  }

  private write(read: Extract<PushRead, { kind: "ready" }>) {
    this.value = read.value;
    const feature = this.buildFeature();
    // Drop the live preview before the real add: it carries the same id, so both would duplicate it.
    if (this.enginePreviewOn) {
      this.store.setPreview(null);
      this.enginePreviewOn = false;
    }
    const reselect =
      (this.round || this.slant) && feature.type === "press-pull" && this.faces.length === 1
        ? this.faceAnchor.clone().addScaledVector(this.axis, this.value)
        : null;
    this.store.addFeature(feature, undefined, this.bindings(feature));
    if (read.unverified) this.store.verifyCommit(feature.id, "Press/Pull");
    this.cleanup();
    this.onDone?.(feature.id);
    return { id: feature.id, reselect };
  }

  /** Only in the drag phase and outside the T pick, where the next face is the stop. */
  private carriesOn(): boolean {
    return !!this.carry && this.phase === "drag" && !this.pickingTarget;
  }

  carryBlocked(): string | null {
    if (!this.dim.accepts("distance") || !this.dim.accepts("taper")) return carryWords.badValue();
    return this.whyNotCarry(this.readCommit());
  }

  private whyNotCarry(read: PushRead): string | null {
    switch (read.kind) {
      case "unreadable":
        return carryWords.badValue();
      case "negative":
        return carryWords.refused(this.negativeSize());
      case "stay":
      case "cancel":
        return carryWords.refused(this.outcomes.refusal ?? "");
      case "ready":
        if (read.refused) return carryWords.refused(this.outcomes.refusal ?? "");
        return read.unverified ? carryWords.wait() : null;
      case "neutral":
        return null;
    }
  }

  commitForCarry(): CarryCommit {
    const read = this.readCommit();
    const why = this.whyNotCarry(read);
    if (why) return { kind: "stayed", why };
    if (read.kind !== "ready") {
      this.cancel();
      return { kind: "nothing" };
    }
    // The carried selection is the next tool's, a reselect of the pushed face would overwrite it.
    return { kind: "added", id: this.write(read).id };
  }

  private armCarry() {
    this.releaseCarry();
    if (!this.carry) return;
    this.releaseCarryRows = awaitTreePick(carryTaker(this, this.carry, this.viewport), () => this.cancel(), {
      keepsOnRewind: true,
      keepsOnCommand: true,
    });
  }

  private releaseCarry() {
    this.releaseCarryRows?.();
    this.releaseCarryRows = null;
    if (this.carryLit) this.viewport.hoverEntity(null);
    this.carryLit = false;
  }

  private lightCarry(x: number, y: number, onHandle: boolean) {
    const lit = !onHandle && this.carriesOn() ? this.viewport.pickEntity(x, y) : null;
    if (lit || this.carryLit) this.viewport.hoverEntity(lit ?? null);
    this.carryLit = !!lit;
  }

  private bindings(feature: Feature): SketchBinding[] {
    if (feature.type !== "press-pull") return [];
    const fields: BoxField[] = [{ box: "distance", field: "distance", value: feature.distance as number }];
    if (typeof feature.taper === "number")
      fields.push({ box: "taper", field: "taper", value: feature.taper, kind: "angle" });
    return boxBindings(this.dim, this.store, feature.id, fields);
  }

  /** Selects the resized face where it now stands once the commit builds, since the viewport's own carry over
   *  looks where the face used to be. */
  private reselectAfterBuild(id: string, at: THREE.Vector3) {
    let started = false;
    // onBuild replays the current state at once, which is the model before the commit.
    const off = this.store.onSessionBuild((s) => {
      if (s.building) {
        started = true;
        return;
      }
      if (!started || !s.result || s.previewBuilt) return;
      off();
      if (this.active || s.errorFeatureId === id) return;
      const face = this.viewport.faceIdNear([at.x, at.y, at.z]);
      if (face != null) this.viewport.selectOnlyFace(face);
    });
  }

  /** The engine derives each face's distance from the target, so commit()'s near-zero guard is skipped. */
  private commitUpTo() {
    const feature = this.buildFeature();
    this.store.addFeature(feature);
    this.cleanup();
    this.onDone?.(feature.id);
  }

  cancel() {
    this.cleanup();
    this.onDone?.(null);
  }

  dependsOn(): readonly string[] {
    return this.restsOn ? [this.restsOn] : [];
  }

  /** A push dragged or typed that Enter would write. */
  get pending(): boolean {
    return this.active && this.phase === "drag" && !this.pickingTarget && !this.neutral;
  }

  get dragging(): boolean {
    return this.grabbing || this.taperGrabbing;
  }

  /** Told when `pending` turns on or off, for the unsaved mark and the close guard. */
  onHeldChange(fn: () => void): () => void {
    return this.held.on(fn);
  }

  /** For a save: the push is written as Enter writes it, which may decline and keep the tool open. A drag still
   *  under the hand is left alone. */
  confirmHeld() {
    if (this.pending && !this.dragging) this.commit();
  }

  private cleanup() {
    this.dropRows();
    this.releaseCarry();
    const el = this.viewport.domElement;
    this.gesture.detach();
    el.style.cursor = "default";
    this.clearPreviewTimer();
    this.unsubBuild?.();
    this.unsubBuild = null;
    this.unsubTint?.();
    this.unsubTint = null;
    this.outcomes.clear();
    this.toggleKind = null;
    this.viewport.clearPressPullGhost();
    this.outline?.dispose();
    this.outline = null;
    this.rigid = null;
    if (this.enginePreviewOn) {
      this.store.setPreview(null);
      this.enginePreviewOn = false;
    }
    this.dim.hide();
    this.guides.clear();
    this.guideAxis = null;
    this.guideSpan = null;
    this.roundPoints = [];
    this.disposeGizmo();
    this.disposeTaperArc();
    this.viewport.clearHover();
    this.viewport.suspendPicking = false;
    this.active = false;
    this.restsOn = null;
    this.grabbing = false;
    this.taperGrabbing = false;
    this.taperHovering = false;
    this.taper = 0;
    this.hovering = false;
    this.value = 0;
    this.round = null;
    this.contact = null;
    this.curve = null;
    this.curveRound = null;
    this.resizing = false;
    this.axisAsk++;
    this.holeAxis = null;
    this.direction = "normal";
    setPrompt(null);
    this.held.sync(this.pending);
  }

  private disposeGizmo() {
    if (!this.gizmo || !this.handle) return;
    this.viewport.removeFromScene(this.gizmo);
    this.handle.dispose();
    this.gizmo = null;
    this.handle = null;
  }
}
