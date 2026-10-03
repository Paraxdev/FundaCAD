// Interactive Offset Face and Thicken. Both are the same gesture, pick solid
// face(s), grab an arrow on the face and scrub along its normal, or type a
// value, so they share one tool, parameterised by `mode`:
//
//   offsetFace : the picked faces MOVE along their normals, the body staying
//                closed (neighbouring faces stretch to follow). A lone round
//                face is resized instead, read as its radius or diameter.
//   thicken    : the picked faces gain a wall, as a new body or joined in.
//   shell      : the picked faces are opened and the body hollowed to a wall,
//                the arrow points into the material and its pull is the wall.
//
// Like Fillet/Press-Pull-on-curved-faces, neither result can be faked
// client-side, a real surface offset needs build123d/OCCT, so the preview is
// engine-driven: the un-committed feature goes through store.setPreview() and
// the normal rebuild pipeline renders it. Commit promotes it (records undo);
// Esc reverts.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore, RebuildState } from "../document/store";
import type { Feature, Selector, Vec3 } from "../types";
import { DimInput, type DimToggleDef } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { fmtLength, snap } from "../ui/units";
import { axisDragDistance, createDragHandle, HANDLE_LENGTH, handleScale, type DragHandle } from "./manipulator";
import { CanvasGesture } from "./canvasGesture";
import { commitDecision } from "./edgeDragMath";
import { deltaForDiameter, deltaForRadius, radialDrag, type RoundFace } from "./radialDrag";
import { offeredResize, type OfferedResize } from "./pressPullAxis";
import { axialSpan, ResizeGuides, resizeAxis, type GuideAxis } from "./resizeGuides";

export type FaceOffsetMode = "offsetFace" | "thicken" | "shell";

type Phase = "pick" | "drag";

const Y_AXIS = new THREE.Vector3(0, 1, 0);

const LABEL: Record<FaceOffsetMode, string> = { offsetFace: "Offset Face", thicken: "Thicken", shell: "Shell" };

/** A drag or a keystroke waits this long for the value to hold still before
 *  the engine is asked. */
const PREVIEW_DEBOUNCE_MS = 150;
/** Under this an offset is no offset at all. */
const MIN_OFFSET = 1e-3;

export class FaceOffsetTool {
  active = false;
  private mode: FaceOffsetMode = "offsetFace";
  private phase: Phase = "pick";
  private faces: Selector[] = [];
  private faceIds: number[] = [];
  private bodyId: string | null = null;
  private anchor = new THREE.Vector3();
  private axis = new THREE.Vector3(0, 0, 1);
  private faceNormal = new THREE.Vector3(0, 0, 1);
  private quat = new THREE.Quaternion();
  /** Signed along `axis`; on a round face the change of radius. */
  private value = 0;
  private symmetric = false; // thicken only
  private previewId = "";
  /** Offset Face only: the face is resized about its axis rather than moved. */
  private round: RoundFace | null = null;
  /** the radius where a tangent neighbour would first be left behind */
  private contact: number | null = null;
  /** Tangent faces follow, remembered for the session. */
  private follow = true;
  private toggleKind: "total" | "follow" | null = null;
  private axisAsk = 0;
  /** Offset Face only: the field reads the whole thickness to the opposite face,
   *  not the change. Kept across uses, like the unit a field was last typed in. */
  private total = false;
  /** The thickness behind the face before any offset, null when it could not be measured. */
  private baseThickness: number | null = null;

  private gizmo: THREE.Group | null = null;
  private handle: DragHandle | null = null;
  private guides = new ResizeGuides();
  private guideAxis: GuideAxis | null = null;
  private guideSpan: [number, number] | null = null;
  private roundPoints: Vec3[] = [];
  private hovering = false;
  private grabbing = false;
  private grabValue = 0;
  private grabProj = 0;
  private downPos = { x: 0, y: 0 };
  private downOnGizmo = false;

  private previewTimer: number | null = null;
  private unsubBuild: (() => void) | null = null;
  /** Our previewed feature the model on screen was built with, null when it
   *  shows none. A refused offset keeps it on screen (setPreview's hold). */
  private shownFeature: Feature | null = null;
  private refused = new Map<string, string>();
  private built = new Set<string>();
  private refusalShown: string | null = null;

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

  get label(): string {
    return LABEL[this.mode];
  }
  get icon(): string {
    return this.mode === "offsetFace" ? "offsetFace" : this.mode;
  }
  get action(): string {
    return this.mode === "offsetFace" ? "offset-face" : this.mode;
  }

  start(mode: FaceOffsetMode, onDone: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.mode = mode;
    this.phase = "pick";
    this.symmetric = false;
    this.onDone = onDone;
    this.viewport.suspendPicking = true;
    this.gesture.attach();

    const pre = this.viewport.selectedFacesForPressPull();
    if (pre) this.beginDrag(pre.selectors, pre.faceIds, pre.anchor, pre.normal, pre.bodyId, pre.round);
    else setPrompt(`Click a face to ${LABEL[mode].toLowerCase()} · Ctrl-click adds more`);
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const faceId = this.viewport.hoverFaceAt(e.clientX, e.clientY);
      this.viewport.domElement.style.cursor = faceId != null ? "pointer" : "default";
      return;
    }
    if (this.grabbing) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      const raw = this.grabValue + (proj - this.grabProj);
      let stepped = snap(raw, this.viewport.snapStep(this.anchor, e.shiftKey));
      if (this.mode === "shell") stepped = Math.max(0, stepped);
      if (stepped === this.value) return; // same step, don't re-trigger an OCCT rebuild
      this.value = stepped;
      this.dim.takeOver("distance");
      this.dim.updateFromCursor({ distance: this.readout() });
      this.refreshPreview();
      return;
    }
    this.hovering = this.hitGizmo(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (!hit) return; // missed the body, let the click orbit
      e.preventDefault();
      e.stopImmediatePropagation();
      this.beginDrag([hit.selector], [hit.faceId], hit.anchor, hit.normal, hit.bodyId,
        this.viewport.roundFaceAt(hit.faceId, hit.anchor));
      return;
    }
    // Ctrl/Cmd-click another face on the SAME body adds it; all faces share the
    // one distance (matching how press-pull and the engine handler treat them)
    if (e.ctrlKey || e.metaKey) {
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (hit && hit.bodyId === this.bodyId) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.faces.push(hit.selector);
        this.faceIds.push(hit.faceId);
        const wasRound = this.round !== null;
        if (this.round && !this.inTangentRun()) this.dropRound();
        if (wasRound !== (this.round !== null)) this.showBox();
        else this.syncToggle();
        this.refreshPreview(true);
      }
      return;
    }
    this.downPos = { x: e.clientX, y: e.clientY };
    this.downOnGizmo = this.hitGizmo(e.clientX, e.clientY);
    if (this.downOnGizmo) {
      e.preventDefault();
      e.stopImmediatePropagation(); // don't orbit while dragging the handle
      // Captured so the release still lands here when it happens over the value box.
      try { this.viewport.domElement.setPointerCapture(e.pointerId); } catch { /* capture optional */ }
      this.grabbing = true;
      this.grabValue = this.value;
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      this.viewport.domElement.style.cursor = "grabbing";
    }
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0 || this.phase !== "drag") return;
    const moved =
      Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (this.grabbing) {
      this.grabbing = false;
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      this.flushPreviewNow();
      // A drag out and back can end within a few pixels of where it began.
      if ((moved || this.value !== this.grabValue) && !this.neutral) this.commit();
      return;
    }
    if (this.downOnGizmo || moved) return;
    this.commit();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { this.cancel(); return; }
    // Thicken's one option worth a key: grow the wall both ways about the surface
    if ((e.key === "s" || e.key === "S") && this.mode === "thicken" && this.phase === "drag") {
      this.symmetric = !this.symmetric;
      this.refreshPreview(true);
    }
  }

  private get quantity(): string {
    if (this.round) return this.full ? "diameter" : "radius";
    return this.mode === "shell" ? "thickness" : "distance";
  }

  private prompt() {
    if (this.phase !== "drag") return;
    if (this.refusalShown) {
      const held = this.held;
      const then = this.dim.isUserDriven("distance")
        ? `type another ${this.quantity}`
        : held !== null && Math.abs(held) >= MIN_OFFSET
          ? `keeping ${this.sizeText(held)}`
          : "drag back";
      setPrompt(`${this.refusalShown} · ${then} · Esc`);
      return;
    }
    const moves = this.followMoves();
    if (moves > 0) {
      setPrompt(`Moves the ${moves === 1 ? "face that runs" : `${moves} faces that run`} smoothly into it · Esc`);
      return;
    }
    const n = this.faces.length > 1 ? `${this.faces.length} faces, ` : "";
    const sym = this.mode === "thicken" ? ` · S = symmetric${this.symmetric ? " (on)" : ""}` : "";
    setPrompt(`${n}drag or type a ${this.quantity}${sym} · click to commit · Esc`);
  }

  private beginDrag(
    faces: Selector[], faceIds: number[], anchor: THREE.Vector3,
    normal: THREE.Vector3, bodyId: string | null = null, round: RoundFace | null = null,
  ) {
    this.faces = faces;
    this.faceIds = faceIds;
    this.bodyId = bodyId;
    this.round = this.mode === "offsetFace" ? round : null;
    this.contact = null;
    this.anchor.copy(anchor);
    this.faceNormal.copy(normal).normalize();
    this.axis.copy(this.round?.radial ?? normal).normalize();
    if (this.mode === "shell") this.axis.negate();
    this.phase = "drag";
    this.value = 0;
    this.previewId = this.store.nextId();
    this.forgetOutcomes();
    this.viewport.clearHover();
    this.buildGizmo();
    this.seedGuides(this.round, faceIds[0]);
    this.showBox();
    const lone = faces[0];
    if (this.round && faces.length === 1 && lone) this.askAxis(lone, bodyId);
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    this.unsubBuild ??= this.store.onBuild((st) => {
      if (st.building || !st.result || this.phase !== "drag") return;
      this.noteBuildOutcome(st);
    });
    this.prompt();
    this.gesture.frame();
  }

  /** The value box for the current selection. A round face reads its size and
   *  offers Tangent faces follow; a flat one may read the thickness behind it. */
  private showBox() {
    this.baseThickness = this.mode === "offsetFace" && !this.round
      ? this.viewport.thicknessBehind(this.anchor, this.faceNormal)
      : null;
    this.toggleKind = this.round ? "follow" : this.baseThickness != null ? "total" : null;
    const toggle = this.toggleKind === "follow" ? this.followToggle() : this.toggleKind === "total" ? this.totalToggle() : undefined;
    this.dim.show([{ name: "distance", ...this.fieldLabel(), kind: "length" }], () => this.commit(), () => this.cancel(),
      toggle, undefined, () => this.onTyped());
    // The box says only what this tool judged, held refusals included.
    this.dim.showOwnProblem(this.refusalShown);
    this.syncToggle();
    this.dim.updateFromCursor({ distance: this.readout() });
  }

  private totalToggle(): DimToggleDef {
    return {
      label: "Total",
      title: "Read and type the whole thickness to the opposite face instead of the change",
      initial: this.total,
      onChange: (on: boolean) => {
        this.total = on;
        this.dim.updateFromCursor({ distance: this.readout() });
      },
    };
  }

  private followToggle(): DimToggleDef {
    return {
      label: "Tangent faces follow",
      title: "On, the faces that run smoothly into this one move with it once it is too small or too big for them to meet it, so a slot narrows as one; off, that size is refused",
      initial: this.follow,
      onChange: (on) => {
        this.follow = on;
        this.refreshPreview(true);
      },
    };
  }

  private followOffered(): boolean {
    return this.faces.length === 1 && (this.round?.tangent?.faces ?? 0) > 0;
  }

  private syncToggle() {
    if (this.toggleKind === "follow") this.dim.setToggleHidden(!this.followOffered());
  }

  /** How many faces Tangent faces follow will move at this size, 0 when it does not engage. */
  private followMoves(): number {
    const r = this.round;
    const t = r?.tangent;
    if (!r || !t || !this.followOffered() || !this.follow || !t.lostWhen || !t.followable) return 0;
    const next = r.radius + this.value;
    const contact = this.contact ?? r.radius;
    const lost = t.lostWhen === "shrink" ? next < contact - 1e-6 : next > contact + 1e-6;
    return lost ? Math.max(1, t.run.length - 1, t.faces) : 0;
  }

  private get full(): boolean {
    return this.round?.full !== false;
  }

  private fieldLabel(): { label: string; icon?: string } {
    if (this.round) return this.full ? { label: "Diameter", icon: "diameter" } : { label: "R" };
    return { label: this.mode === "shell" ? "T" : "D" };
  }

  /** Never removes the face: that is press/pull's gesture, an offset at or
   *  below zero is the engine's to refuse with the reason. */
  private radial(value: number) {
    const r = this.round!;
    return radialDrag(r.radius, value, r.solidInside, false);
  }

  private negativeSize(): string {
    return `a ${this.quantity} can't be negative`;
  }

  /** Typing a size is absolute, so a minus sign is a mistake to say at once. */
  private onTyped() {
    if (!this.round) return;
    const v = this.dim.getValue("distance");
    if (v != null && v < 0) this.dim.flag(this.negativeSize());
  }

  /** How far the face itself has moved along `axis`. */
  private get ride(): number {
    if (this.mode === "shell") return 0;
    return this.mode === "thicken" && this.symmetric ? this.value / 2 : this.value;
  }

  /** keep the handle a constant on-screen size, point it the way we're dragging,
   *  and keep a typed value previewing live (the pointer may be still). The
   *  handle and its box ride on the face where it is now; the drag is still
   *  measured from `anchor`, where the face started. */
  private tick() {
    if (this.phase === "drag" && this.gizmo) {
      const sign = this.value < 0 ? -1 : 1;
      const dir = this.axis.clone().multiplyScalar(sign);
      this.quat.setFromUnitVectors(Y_AXIS, dir);
      const at = this.anchor.clone().addScaledVector(this.axis, this.ride);
      const k = this.viewport.pixelWorldSize(at);
      const scale = k * handleScale(this.viewport.modelDiagonal(), k);
      this.gizmo.position.copy(at);
      this.gizmo.quaternion.copy(this.quat);
      this.gizmo.scale.setScalar(scale);
      // Tone tracks the DIRECTION of the offset: amber grows the face, red
      // pulls it in.
      this.handle?.paint({
        hot: this.hovering || this.grabbing,
        tone: sign < 0 && this.mode !== "shell" ? "cut" : "idle",
        refused: this.refusalShown !== null,
      });
      this.placeGuides(at);
      const s = this.viewport.projectToScreen(at);
      const tip = this.viewport.projectToScreen(at.clone().addScaledVector(dir, scale * HANDLE_LENGTH));
      this.dim.positionPast(tip, { x: tip.x - s.x, y: tip.y - s.y }, this.viewport.domElement.getBoundingClientRect());
      // The field is the truth once typed, including its SIGN. While dragging
      // it displays |value|, so an unguarded read-back would strip an inward
      // drag's sign (the abs-display trap press-pull documents).
      if (!this.grabbing && this.dim.isUserDriven("distance")) {
        const raw = this.dim.getValue("distance");
        if (raw != null && !(this.round && raw < 0)) {
          const v = this.fromField(raw);
          if (Math.abs(v - this.value) > 1e-6) {
            this.value = v;
            this.refreshPreview();
          }
        }
      }
      this.gesture.frame();
    }
  }

  private placeGuides(handle: THREE.Vector3) {
    const axis = this.guideAxis;
    const span = this.guideSpan;
    if (!this.round || !axis || !span) {
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
    for (const t of this.viewport.faceTriangles(faceId)) {
      for (const v of [t.a, t.b, t.c]) this.roundPoints.push([v.x, v.y, v.z]);
    }
    this.setGuideAxis({ origin: round.cylinder.point, dir: round.cylinder.axis });
  }

  private setGuideAxis(axis: GuideAxis) {
    this.guideAxis = axis;
    this.guideSpan = axialSpan(this.roundPoints, axis);
  }

  private askAxis(face: Selector, bodyId: string | null) {
    const ask = ++this.axisAsk;
    void this.store.faceAxis(face, bodyId).then((reply) => {
      if (ask !== this.axisAsk || !this.active || this.phase !== "drag") return;
      this.adoptResize(offeredResize(reply), resizeAxis(reply));
    });
  }

  /** The engine's exact size, wrap and tangent run replace the mesh's guess. */
  private adoptResize(r: OfferedResize | null, axis: GuideAxis | null) {
    const round = this.round;
    if (!round || !r) return;
    if (axis) this.setGuideAxis(axis);
    this.round = { ...round, radius: r.radius, full: r.full, solidInside: !r.concave, tangent: r.tangent };
    this.contact = r.contact;
    const { label, icon } = this.fieldLabel();
    this.dim.setFieldLabel("distance", label, icon);
    this.dim.updateFromCursor({ distance: this.readout() });
    this.syncToggle();
    if (this.neutral) this.prompt();
    else this.refreshPreview(true);
  }

  /** Every selected face lies in the first round face's tangent run, so the
   *  selection still resizes as one, a whole slot picked face by face. */
  private inTangentRun(): boolean {
    const run = this.round?.tangent?.run;
    if (!run?.length) return false;
    const ids = new Set(run.map((p) => this.viewport.faceIdNear(p)));
    return this.faceIds.every((id) => ids.has(id));
  }

  /** The selection no longer resizes as one round face: read the drag as a
   *  signed offset along the first face's outward normal, the arrow kept in place. */
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
    this.axisAsk++;
  }

  private get totalShown(): boolean {
    return this.total && this.baseThickness != null;
  }

  /** What the field shows for the current offset: the size a round face would
   *  become, the whole thickness in Total, the change otherwise. */
  private readout(): number {
    if (this.round) {
      const d = this.radial(this.value);
      return this.full ? d.diameter : d.radius;
    }
    return this.totalShown ? this.baseThickness! + this.value : Math.abs(this.value);
  }

  /** The offset a value typed into the field asks for. */
  private fromField(v: number): number {
    const r = this.round;
    if (r) return this.full ? deltaForDiameter(r.radius, v) : deltaForRadius(r.radius, v);
    return this.totalShown ? v - this.baseThickness! : v;
  }

  /** A value for the prompt, said the way the field reads it. */
  private sizeText(value: number): string {
    if (this.round) {
      const d = this.radial(value);
      return this.full ? `⌀${fmtLength(d.diameter)}` : `R${fmtLength(d.radius)}`;
    }
    return fmtLength(this.totalShown ? this.baseThickness! + value : Math.abs(value));
  }

  private get neutral(): boolean {
    return Math.abs(this.value) < MIN_OFFSET;
  }

  private keyOf(f: Feature): string {
    const rest: Record<string, unknown> = { ...f };
    delete rest.id;
    return JSON.stringify(rest);
  }

  /** Everything about an offset except how far, so a value held from earlier
   *  in the drag still answers the same question. */
  private questionOf(f: Feature): string {
    const rest: Record<string, unknown> = { ...f };
    for (const k of ["id", "distance", "thickness"]) delete rest[k];
    return JSON.stringify(rest);
  }

  /** The drag value a sent feature was built from. */
  private valueOf(f: Feature): number | null {
    if (f.type === "offsetFace" && typeof f.distance === "number") {
      const r = this.round;
      return r && !r.solidInside ? -f.distance : f.distance;
    }
    if ((f.type === "thicken" || f.type === "shell") && typeof f.thickness === "number") return f.thickness;
    return null;
  }

  /** The value the model on screen was built at for the current question, or null. */
  private get held(): number | null {
    const f = this.shownFeature;
    if (!f) return null;
    return this.questionOf(f) === this.questionOf(this.buildFeature()) ? this.valueOf(f) : null;
  }

  private forgetOutcomes() {
    this.shownFeature = null;
    this.refused = new Map();
    this.built = new Set();
  }

  /** Record what the kernel said about the offset it was SENT, which during a
   *  fast drag is often not the one on the handle any more. */
  private noteBuildOutcome(s: RebuildState) {
    const sent = s.previewBuilt?.find((f) => f.id === this.previewId) ?? null;
    const held = s.heldRefusal?.featureId === this.previewId ? s.heldRefusal : null;
    if (!sent) this.shownFeature = null;
    else if (held) this.refused.set(this.keyOf(sent), refusalText(held.message));
    else if (s.errorFeatureId != null || !s.errorMessage) {
      this.shownFeature = sent;
      this.built.add(this.keyOf(sent));
    }
    this.refreshRefusal();
  }

  /** Paint the refusal, or take it down, on the handle, the value box and the
   *  prompt. It stays up until a value builds, so the box does not flicker
   *  while the next answer is on its way. */
  private refreshRefusal() {
    let reason: string | null = null;
    if (!this.neutral) {
      const k = this.keyOf(this.buildFeature());
      reason = this.refused.get(k) ?? (this.built.has(k) ? null : this.refusalShown);
    }
    if (reason === this.refusalShown) return;
    this.refusalShown = reason;
    this.dim.showOwnProblem(reason);
    this.handle?.paint({ refused: reason !== null });
    this.viewport.requestRender();
    this.prompt();
  }

  private refreshPreview(now = false) {
    this.refreshRefusal();
    this.prompt();
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

  /** `hold` keeps the last offset that built on screen while the kernel
   *  refuses this one. An offset already refused is not asked again. */
  private pushPreview() {
    if (!this.active || this.phase !== "drag") return;
    if (this.neutral) {
      this.store.setPreview(null);
    } else {
      const f = this.buildFeature();
      if (!this.refused.has(this.keyOf(f))) this.store.setPreview(f, { hold: true });
    }
    this.refreshRefusal();
  }

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

  /** The shared drag handle; tick() scales it to a constant screen size. */
  private buildGizmo() {
    this.handle = createDragHandle();
    const g = this.handle.group;
    this.gizmo = g;
    this.viewport.addToScene(g);
  }

  private hitGizmo(x: number, y: number): boolean {
    const gizmo = this.gizmo;
    if (!gizmo) return false;
    return this.viewport.probe(x, y, (rc) => rc.intersectObjects(gizmo.children, false).length > 0) ?? false;
  }

  private buildFeature(): Feature {
    const v = Math.round(this.value * 1000) / 1000;
    const faces = this.faces.length === 1 ? (this.faces[0] ?? this.faces) : this.faces;
    const body = this.bodyId != null ? { body: this.bodyId } : {};
    if (this.mode === "shell") {
      return { id: this.previewId, type: "shell", faces, thickness: Math.abs(v) };
    }
    if (this.mode === "thicken") {
      return {
        id: this.previewId, type: "thicken", faces, thickness: v,
        // thickening faces OF an existing solid should grow that solid; a
        // standalone surface body has nothing to join, and the engine's
        // _boolean_into_bodies falls back to a new body in that case anyway
        operation: "join",
        ...(this.symmetric ? { symmetric: true } : {}),
        ...body,
      };
    }
    const distance = this.round ? Math.round(this.radial(this.value).distance * 1000) / 1000 : v;
    return {
      id: this.previewId, type: "offsetFace", faces, distance,
      ...(this.followOffered() ? { followTangent: this.follow } : {}),
      ...body,
    };
  }

  private commit() {
    if (this.phase !== "drag") return this.cancel();
    const raw = this.dim.getValue("distance");
    const typed = this.dim.isUserDriven("distance");
    if (raw == null && typed) {
      setPrompt("That number can't be read · Esc");
      return;
    }
    if (typed && raw != null && this.round && raw < 0) {
      this.dim.flag(this.negativeSize());
      return;
    }
    const want = typed && raw != null ? this.fromField(raw) : this.value;
    if (Math.abs(want - this.value) > 1e-6) {
      this.value = want;
      this.refreshPreview(true);
    } else {
      this.flushPreviewNow();
    }
    if (this.neutral) {
      // keep the tool alive: silently cancelling reads as "nothing happened"
      setPrompt(this.round ? `The ${this.quantity} is unchanged` : "Nothing to commit yet");
      return;
    }
    const k = this.keyOf(this.buildFeature());
    const decision = commitDecision({
      value: Math.round(this.value * 1000) / 1000,
      verdict: this.refused.has(k) ? "refused" : this.built.has(k) ? "builds" : "unknown",
      settled: this.shownFeature !== null && this.keyOf(this.shownFeature) === k,
      shown: this.held,
      typed,
      meaningful: (x) => Math.abs(x) >= MIN_OFFSET,
    });
    if (decision.action === "stay") return this.prompt();
    if (decision.action === "cancel") return this.cancel();
    this.value = decision.value;
    const feature = this.buildFeature();
    this.store.setPreview(null); // addFeature re-adds it as a committed feature
    this.store.addFeature(feature);
    if (decision.unverified) this.store.verifyCommit(feature.id, `${LABEL[this.mode]} ${this.sizeText(this.value)}`);
    this.cleanup();
    this.onDone?.(feature.id);
  }

  cancel() {
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    this.gesture.detach();
    el.style.cursor = "default";
    this.clearPreviewTimer();
    this.unsubBuild?.();
    this.unsubBuild = null;
    this.forgetOutcomes();
    this.store.setPreview(null);
    this.dim.hide();
    this.guides.clear();
    this.guideAxis = null;
    this.guideSpan = null;
    this.roundPoints = [];
    this.disposeGizmo();
    this.viewport.clearHover();
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grabbing = false;
    this.hovering = false;
    this.value = 0;
    this.round = null;
    this.contact = null;
    this.axisAsk++;
    this.toggleKind = null;
    this.refusalShown = null;
    setPrompt(null);
  }

  private disposeGizmo() {
    if (!this.gizmo) return;
    this.viewport.removeFromScene(this.gizmo);
    this.handle?.dispose();
    this.gizmo = null;
    this.handle = null;
  }
}

/** The engine's refusal, without the feature name it leads with. */
function refusalText(message: string): string {
  return message.replace(/^(Offset face|Thicken|Shell)[^:]*:\s*/i, "");
}
