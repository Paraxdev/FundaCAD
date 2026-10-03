// Interactive Press/Pull (MCAD-style): pick a solid face, then grab the drag
// handle on it and drag along the face normal to add material (boss / pull
// out), cut material (pocket / push in), or resize a cylindrical face (hole/boss),
// with a LIVE preview. Same interaction as Fillet/Chamfer (EdgeFeatureTool): an
// on-top, constant-screen-size gizmo you grab and scrub; a clean click commits.
//
// Like Fillet (and unlike sketch Extrude) the result can't be faked client-side,
// a real surface offset needs OCCT, so the preview is engine-driven:
// the un-committed feature is appended via store.setPreview() and the normal
// rebuild pipeline renders it. Commit promotes it (records undo); Esc reverts.
//
// The end of a hole (its cone, cap or floor) can instead move along the hole's
// axis, which deepens the hole rather than widening its end (pressPullAxis.ts).

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore, RebuildState } from "../document/store";
import type { Feature, PressPullDirection, PressPullMode, Selector, Vec3 } from "../types";
import { DimInput, type DimFieldDef, type DimToggleDef } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { fmtLength, snap } from "../ui/units";
import {
  axisDragDistance,
  createDragHandle,
  createRotationArc,
  fluentRelease,
  HANDLE_LENGTH,
  HANDLE_UP,
  type DragHandle,
} from "./manipulator";
import { draftAngle, draftDelta } from "./draftMath";
import { collapseDiameter, deltaForDiameter, deltaForRadius, radialDrag, type RoundFace } from "./radialDrag";
import { CanvasGesture } from "./canvasGesture";
import { commitDecision } from "./edgeDragMath";
import {
  anchorOnAxis,
  DIRECTION_LABEL,
  initialDirection,
  offeredAxis,
  offeredResize,
  type HoleAxis,
  type OfferedResize,
} from "./pressPullAxis";
import { axialSpan, ResizeGuides, resizeAxis, type GuideAxis } from "./resizeGuides";

/** Steepest taper the tool offers, degrees, just under the engine's 89 fold limit. */
const MAX_PP_TAPER = 88;
/** A taper needs travel to swing about; under this the arc is not offered. */
const PP_TAPER_MIN = 1;
/** How far above the pushed face the taper arc floats, in pixels. */
const PP_TAPER_ABOVE_PX = 48;
/** A drag or a keystroke waits this long for the value to hold still before
 *  the engine is asked, as the fillet drag does. */
const PREVIEW_DEBOUNCE_MS = 150;
/** Under this a push is no push at all, the same floor commit uses. */
const MIN_PUSH = 1e-3;

/** A deterministic unit vector lying IN the plane of a face with the given
 *  normal: world X projected onto the plane, or world Y where the face points
 *  along X. The taper arc runs along it and the inward drag is measured against
 *  it. */
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

const Y_AXIS = HANDLE_UP;

const MODES: PressPullMode[] = ["auto", "join", "cut", "new", "intersect"];
const MODE_LABEL: Record<PressPullMode, string> = { auto: "Auto", join: "Join", cut: "Cut", new: "New", intersect: "Intersect" };

export class PressPullTool {
  active = false;
  private phase: Phase = "pick";
  private faces: Selector[] = []; // one or more faces pushed together by `value`
  private faceIds: number[] = []; // their mesh faceIds (for the instant ghost preview)
  private upTo: Selector | null = null; // "extrude up to this surface" target (else by distance)
  private pickingTarget = false; // waiting for the user to click the up-to target surface
  private bodyId: string | null = null; // the body that owns the picked face
  private anchor = new THREE.Vector3(); // gizmo origin = the clicked point on the face
  private axis = new THREE.Vector3(0, 0, 1); // drag axis (unit) = face outward normal, or the outward radial on a round face
  private quat = new THREE.Quaternion(); // Y -> current arrow direction
  private value = 0; // signed distance in mm (+ along the axis / out, − in)
  /** Set when a lone CYLINDRICAL face is selected, or a run of faces it runs
   *  smoothly into: the drag then resizes it rather than moving it, `value` is
   *  the radial delta, and the readout is a diameter on a full round and a
   *  radius on a partial arc. Null for every other selection. */
  private round: RoundFace | null = null;
  /** the radius where a tangent neighbour would first be left behind */
  private contact: number | null = null;
  /** Some selected face is round, so the push resizes rather than slides:
   *  no taper, no boolean mode and no up to. Outlives `round` when a Ctrl-click
   *  adds a face outside its tangent run. */
  private resizing = false;
  /** Tangent faces follow, remembered for the session. */
  private follow = true;
  private toggleKind: "mode" | "follow" | null = null;
  private mode: PressPullMode = "auto";
  /** Along the axis only once the engine has said the face has one worth
   *  offering (`holeAxis`); the button stays hidden until then. */
  private direction: PressPullDirection = "normal";
  private holeAxis: HoleAxis | null = null;
  private axisAsk = 0; // bumped per question, so a late answer for another face is dropped
  private directionBtn: HTMLButtonElement | null = null;
  // Where the arrow stands and points along the normal, restored on switching back.
  private faceAnchor = new THREE.Vector3();
  private faceNormal = new THREE.Vector3(0, 0, 1);
  private lastPointer = { x: 0, y: 0 };
  private previewId = ""; // id shared by the live preview and the committed feature

  private gizmo: THREE.Group | null = null;
  private guides = new ResizeGuides();
  /** the round face's axis and its span along it, the mesh fit's until the engine answers */
  private guideAxis: GuideAxis | null = null;
  private guideSpan: [number, number] | null = null;
  private roundPoints: Vec3[] = [];
  private handle: DragHandle | null = null;
  private hovering = false;
  private grabbing = false;

  // --- taper (lean the pushed walls), for a PLANAR by-distance push only ---
  /** Degrees, positive narrows the far end. Only meaningful on the planar prism
   *  path; a round resize or an up-to push never offers it. */
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
  /** true when this drag began on the passive selection handle rather than on
   *  our own gizmo, a one-press gesture, so releasing it finishes (see onUp). */
  private fluentGrab = false;
  private grabValue = 0; // value at grab start (relative drag)
  private grabProj = 0; // axis projection at grab start
  private downPos = { x: 0, y: 0 };
  private downOnGizmo = false;

  private previewTimer: number | null = null;
  private unsubBuild: (() => void) | null = null;
  /** Our previewed feature the model on screen was built with, null when it
   *  shows none. A refused push keeps it on screen (setPreview's hold). */
  private shownFeature: Feature | null = null;
  /** What the kernel said about each push sent this gesture, by keyOf. */
  private refused = new Map<string, string>();
  private built = new Set<string>();
  /** the refusal painted on the handle, box and prompt */
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

  /** `opts.grabAt` is the direct-manipulation entry (features/faceNudge.ts):
   *  the user pressed the handle that appears the moment a face is selected, so
   *  we arm from that pre-selection AND begin scrubbing inside the same
   *  pointerdown. The handle derived its anchor and axis from the same
   *  selectedFacesForPressPull() call this does, so there is nothing to adopt
   *  and nothing that can disagree. */
  start(onDone: (id: string | null) => void, opts?: { grabAt?: { x: number; y: number } }) {
    if (this.active) return;
    // pre-selection: faces already selected → skip straight to the drag.
    // Read BEFORE anything is installed, because the direct-manipulation entry
    // needs the selection its handle was drawn for: if a rebuild landed between
    // the paint and the press, arming into the pick phase would be a
    // bait-and-switch into a tool nobody asked for, and it would hold
    // toolBusy() until noticed.
    const pre = this.viewport.selectedFacesForPressPull();
    if (opts?.grabAt && !pre) return;
    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.viewport.suspendPicking = true; // we drive our own face picking
    this.gesture.attach();

    if (pre) {
      this.beginDrag(pre.selectors, pre.faceIds, pre.anchor, pre.normal, pre.bodyId, pre.round);
      if (opts?.grabAt) this.grabHandle(opts.grabAt.x, opts.grabAt.y);
    } else {
      setPrompt("Click a face · Ctrl-click adds more");
    }
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
      // Swing the wall over: a drag inward against the arc's axis leans it in, by
      // atan(inset / travel), the same reading a draft takes (draftMath).
      const depth = Math.abs(this.value);
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.taperTop, this.taperAxis);
      const inset = this.taperGrabInset + (this.taperGrabProj - proj);
      const stepped = snap(draftAngle(inset, depth, MAX_PP_TAPER), e.shiftKey ? 0.1 : 1);
      this.taper = Math.max(-MAX_PP_TAPER, Math.min(MAX_PP_TAPER, stepped));
      this.dim.takeOver("taper");
      this.dim.updateFromCursor({ taper: this.taper });
      this.refreshPreview();
      return;
    }
    if (this.grabbing) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor, this.axis);
      // Snapped to the zoom's own lattice (viewport/dragStep.ts), 0.1mm on a
      // fitted hand-sized part, finer as you wheel in, finer again with Shift.
      const raw = this.grabValue + (proj - this.grabProj);
      const stepped = snap(raw, this.viewport.snapStep(this.anchor, e.shiftKey));
      if (stepped === this.value) return; // same step, don't re-trigger an OCCT rebuild
      this.value = stepped;
      this.dim.takeOver("distance");
      this.dim.updateFromCursor({ distance: this.readout() });
      this.refreshPreview();
      return;
    }
    // idle: highlight the handle (or the taper arc) when hovered so it reads as grabbable
    this.taperHovering = this.hitTaper(e.clientX, e.clientY);
    this.hovering = !this.taperHovering && this.hitGizmo(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hovering || this.taperHovering ? "grab" : "default";
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
    // drag phase: clicking the "up to" target surface (after pressing T).
    // Consume EVERY click in this mode, a miss must never fall through to the
    // clean-click-commits path and fire a stray plain commit (audit bug #3).
    if (this.pickingTarget) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (hit && !this.faceIds.includes(hit.faceId)) {
        this.upTo = hit.selector;
        this.commitUpTo();
      } else {
        setPrompt("Click the face to stop at · Esc");
      }
      return;
    }
    // drag phase: Ctrl/Cmd-click another face on the SAME body adds it to the
    // operation (all faces share the one distance). Do this before the grab check.
    if (e.ctrlKey || e.metaKey) {
      const hit = this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
      if (hit && hit.bodyId === this.bodyId) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.faces.push(hit.selector);
        this.faceIds.push(hit.faceId);
        // The axis was the first face's; the faces share one arrow from here.
        this.axisAsk++;
        this.holeAxis = null;
        if (this.directionBtn) this.directionBtn.style.display = "none";
        if (this.direction === "axis") this.setDirection("normal");
        const was = { resizing: this.resizing, round: this.round !== null };
        if (this.viewport.roundFaceAt(hit.faceId, hit.anchor)) this.resizing = true;
        if (this.round && !this.inTangentRun()) this.dropRound();
        if (this.resizing) {
          this.mode = "auto";
          this.taper = 0;
        }
        if (was.resizing !== this.resizing || was.round !== (this.round !== null)) this.showBox();
        else this.syncToggle();
        this.refreshPreview(true);
      }
      return;
    }
    // grabbing the taper arc swings the wall; tested before the push handle since
    // it floats above it and setting the lean is never a commit.
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
    // grabbing the handle scrubs; a clean click elsewhere commits
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
    if (this.taperGrabbing) {
      // Let go of the arc and the push is done, a grab-drag-release is one whole
      // gesture. A press that never travelled is not a swing, so it stays put.
      this.taperGrabbing = false;
      const moved = Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
      this.viewport.domElement.style.cursor = this.taperHovering ? "grab" : "default";
      if (moved) this.commit();
      return;
    }
    if (this.grabbing) {
      this.grabbing = false;
      // commit and cancel both want the kernel already chasing where the drag ended
      this.flushPreviewNow();
      const release = fluentRelease({
        fluent: this.fluentGrab,
        moved:
          Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3,
        // Same threshold commit() uses to decide there is nothing to commit,
        // read here so a drag that ended back at the face cancels out of a tool
        // the user never explicitly opened, instead of parking them in it with
        // a "nothing to commit" prompt.
        meaningful: !this.neutral,
      });
      // Cleared BEFORE dispatching, not in cleanup: commit() can decline and
      // leave the tool alive (an unreadable number in the field), and a stale
      // flag would then make the NEXT release re-run this decision on a gesture
      // that ended long ago.
      this.fluentGrab = false;
      if (release === "commit") return this.commit();
      if (release === "cancel") return this.cancel();
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      return;
    }
    const moved =
      Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (this.downOnGizmo || moved) return;
    // Clean click on ANOTHER face = extrude UP TO it (mainstream MCAD "to object",
    // no T needed: pick a face, then click the face to meet). Empty space or
    // one of the operation's own faces = commit as before.
    //
    // Never on a round face: "up to" answers how FAR to travel, and a resize is
    // not travelling anywhere. Offering it would read the click as a target and
    // commit a distance the user never asked for.
    const hit = this.resizing ? null : this.viewport.pickFaceForPressPull(e.clientX, e.clientY);
    if (hit && !this.faceIds.includes(hit.faceId)) {
      this.upTo = hit.selector;
      this.commitUpTo();
      return;
    }
    this.commit();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (this.pickingTarget) {
        this.pickingTarget = false;
        // restore the distance field T-mode hid (audit bug #2: leaving it
        // active let Enter commit a plain distance mid-target-pick)
        this.showBox();
        this.refreshPreview(true);
        return;
      }
      this.cancel();
      return;
    }
    if ((e.key === "t" || e.key === "T") && this.phase === "drag" && !this.pickingTarget && !this.resizing) {
      this.pickingTarget = true;
      this.dim.hide(); // Enter must not commit a plain distance while picking
      this.clearPreviewTimer();
      this.viewport.clearPressPullGhost();
      this.viewport.setPeek(null);
      setPrompt("Click the face to stop at · Esc");
    }
  }

  private beginDrag(faces: Selector[], faceIds: number[], anchor: THREE.Vector3, normal: THREE.Vector3, bodyId: string | null = null, round: RoundFace | null = null) {
    this.faces = faces;
    this.faceIds = faceIds;
    this.upTo = null;
    this.pickingTarget = false;
    this.bodyId = bodyId;
    this.round = round;
    this.contact = null;
    this.resizing = round !== null || (faceIds.length > 1 && faceIds.some((id) => this.viewport.roundFaceAt(id, anchor) !== null));
    this.anchor.copy(anchor);
    this.axis.copy(round?.radial ?? normal).normalize();
    this.faceAnchor.copy(anchor);
    this.faceNormal.copy(normal).normalize();
    this.seedGuides(round, faceIds[0]);
    this.direction = "normal";
    this.holeAxis = null;
    this.phase = "drag";
    this.value = 0;
    this.taper = 0;
    this.previewId = this.store.nextId();
    this.forgetOutcomes();
    this.viewport.clearHover();
    this.buildGizmo();
    this.mode = "auto";
    this.showBox();
    const lone = faces[0];
    if (faces.length === 1 && lone) this.askAxis(lone, bodyId);
    const s = this.viewport.projectToScreen(this.anchor);
    this.dim.position(s.x, s.y);
    this.unsubBuild ??= this.store.onBuild((st) => {
      if (st.building || !st.result || this.phase !== "drag") return;
      this.noteBuildOutcome(st);
    });
    this.promptNow();
    this.gesture.frame();
  }

  /** The value box for the current selection. The ∠ taper field rides beside
   *  the distance for a push that slides, the only one that leans a wall; a
   *  resize has none, and its free switch is Tangent faces follow instead of
   *  the boolean mode. */
  private showBox() {
    const defs: DimFieldDef[] = [{ name: "distance", ...this.fieldLabel(), kind: "length" }];
    if (!this.resizing) defs.push({ name: "taper", label: "Angle", icon: "angle", kind: "angle" });
    this.toggleKind = !this.resizing ? "mode" : this.round ? "follow" : null;
    const toggle = this.toggleKind === "mode" ? this.modeToggle() : this.toggleKind === "follow" ? this.followToggle() : undefined;
    this.dim.show(defs, () => this.commit(), () => this.cancel(), toggle, this.directionButton(), () => this.onTyped());
    this.syncToggle();
    // A round face opens showing the size it ALREADY is, not a zero, the field
    // is a size here, and the current one is the number you are about to edit.
    // A flat face opens at 0 because there the field is a travel.
    this.dim.updateFromCursor({ distance: this.readout(), ...(this.resizing ? {} : { taper: this.taper }) });
  }

  private get full(): boolean {
    return this.round?.full !== false;
  }

  private fieldLabel(): { label: string; icon?: string } {
    return !this.round ? { label: "D" } : this.full ? { label: "Diameter", icon: "diameter" } : { label: "R" };
  }

  /** What the heads-up field shows for the current drag: the size a round face
   *  would become, a diameter on a full round (0 while the drag is asking for
   *  it to go) and a radius on a partial arc, the travelled distance on any other. */
  private readout(): number {
    const r = this.round;
    if (!r) return Math.abs(this.value);
    const d = radialDrag(r.radius, this.value, r.solidInside, this.full);
    return this.full ? d.diameter : d.radius;
  }

  /** The inverse: a number the user TYPED into that field, read back as a drag. */
  private fromReadout(v: number): number {
    const r = this.round;
    if (!r) return v;
    return this.full ? deltaForDiameter(r.radius, v) : deltaForRadius(r.radius, v);
  }

  private negativeSize(): string {
    return `a ${this.full ? "diameter" : "radius"} can't be negative`;
  }

  /** Typing a size is absolute, so a minus sign is a mistake to say at once. */
  private onTyped() {
    if (!this.round) return;
    const v = this.dim.getValue("distance");
    if (v != null && v < 0) this.dim.flag(this.negativeSize());
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
      const at = this.anchor.clone().addScaledVector(this.axis, this.value);
      const k = this.viewport.pixelWorldSize(at);
      this.gizmo.position.copy(at);
      this.gizmo.quaternion.copy(this.quat);
      this.gizmo.scale.setScalar(k);
      // Tone tracks the DIRECTION of the push: amber adds material, red cuts.
      this.handle?.paint({
        hot: this.hovering || this.grabbing,
        tone: sign < 0 ? "cut" : "idle",
        refused: this.refusalShown !== null,
      });
      this.placeTaperArc(dir, k);
      this.placeGuides(at);
      const s = this.viewport.projectToScreen(at);
      const tip = this.viewport.projectToScreen(at.clone().addScaledVector(dir, k * HANDLE_LENGTH));
      this.dim.positionPast(tip, { x: tip.x - s.x, y: tip.y - s.y }, this.viewport.domElement.getBoundingClientRect());
      if (!this.grabbing && this.dim.isUserDriven("distance")) {
        const v = this.dim.getValue("distance");
        if (v != null && !(this.round && v < 0)) {
          // the field is the truth: typed sign is preferred (out = +, cut = −). The old
          // code re-applied the drag's sign onto |v|, so a typed "-2" after an
          // outward drag silently JOINED 2 instead of cutting.
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
    for (const t of this.viewport.faceTriangles(faceId)) {
      for (const v of [t.a, t.b, t.c]) this.roundPoints.push([v.x, v.y, v.z]);
    }
    this.setGuideAxis({ origin: round.cylinder.point, dir: round.cylinder.axis });
  }

  private setGuideAxis(axis: GuideAxis) {
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

  /** One push, everything but its id. */
  private keyOf(f: Feature): string {
    const rest: Record<string, unknown> = { ...f };
    delete rest.id;
    return JSON.stringify(rest);
  }

  /** Everything about a push except how far, so a size held from earlier in
   *  the drag still answers the same question. */
  private questionOf(f: Feature): string {
    const rest: Record<string, unknown> = { ...f };
    for (const k of ["id", "type", "distance", "operation"]) delete rest[k];
    return JSON.stringify(rest);
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
    const f = this.shownFeature;
    if (!f) return null;
    return this.questionOf(f) === this.questionOf(this.buildFeature()) ? this.valueOf(f) : null;
  }

  private forgetOutcomes() {
    this.shownFeature = null;
    this.refused = new Map();
    this.built = new Set();
  }

  /** Record what the kernel said about the push it was SENT, which during a
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
    this.refreshGhost();
    this.refreshRefusal();
  }

  /** Paint the refusal, or take it down, on the handle, the value box and the
   *  prompt. A refusal stays up until a value builds, so the box does not
   *  flicker while the next answer is on its way. */
  private refreshRefusal() {
    let reason: string | null = null;
    if (!this.neutral && !this.pickingTarget) {
      const k = this.keyOf(this.buildFeature());
      reason = this.refused.get(k) ?? (this.built.has(k) ? null : this.refusalShown);
    }
    if (reason === this.refusalShown) return;
    this.refusalShown = reason;
    this.dim.showOwnProblem(reason);
    this.handle?.paint({ refused: reason !== null });
    this.viewport.requestRender();
    this.promptNow();
  }

  /** The instant cap of a resize, until the engine's own preview is on screen.
   *  Only over the model it was picked on: a preview renumbers the faces. */
  private refreshGhost() {
    const r = this.round;
    const k = this.neutral ? null : this.keyOf(this.buildFeature());
    if (!r || this.pickingTarget || this.shownFeature || this.removing || k === null || this.refused.has(k)) {
      this.viewport.clearPressPullGhost();
      return;
    }
    this.viewport.setPressPullGhost(this.faceIds, this.value, r);
  }

  /** How many faces Tangent faces follow will move at this size, 0 when it
   *  does not engage. */
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
    if (!r) return fmtLength(Math.abs(value));
    const d = radialDrag(r.radius, value, r.solidInside, this.full);
    if (d.mode === "remove") return "it removed";
    return this.full ? `⌀${fmtLength(d.diameter)}` : `R${fmtLength(d.radius)}`;
  }

  private promptNow() {
    if (this.phase !== "drag" || this.pickingTarget) return;
    const r = this.round;
    if (this.refusalShown) {
      const shown = this.shown;
      const then = this.dim.isUserDriven("distance")
        ? `type another ${r ? (this.full ? "diameter" : "radius") : "distance"}`
        : shown !== null && Math.abs(shown) >= MIN_PUSH
          ? `keeping ${this.sizeText(shown)}`
          : "drag back";
      setPrompt(`${this.refusalShown} · ${then} · Esc`);
      return;
    }
    if (r) {
      // Nothing to ghost once the drag is asking for the face to GO; the
      // readout dropping to 0 and this line are what say so.
      if (this.removing) return setPrompt("Release to remove this face · drag back to keep it · Esc");
      const moves = this.followMoves();
      if (moves > 0) {
        return setPrompt(`Moves the ${moves === 1 ? "face that runs" : `${moves} faces that run`} smoothly into it · Esc`);
      }
      return setPrompt(this.full
        ? `Drag or type a diameter · under ${collapseDiameter(r.radius).toFixed(2)}mm removes it · Esc`
        : "Drag or type a radius · Esc");
    }
    if (this.faces.length > 1) return setPrompt(`${this.faces.length} faces · drag or type a distance · click to commit · Esc`);
    setPrompt("Drag or type a value, negative cuts · click a face to stop at it · Esc");
  }

  /** The exact solid through the engine for every push. A flat face carries the
   *  faces around it along their own slopes and a round one re-trims its
   *  neighbours, which no ghost can draw. `hold` keeps the last push that built
   *  on screen while the kernel refuses this one, the way fillet does. A drag
   *  or a keystroke waits for the value to hold still; a discrete change goes
   *  `now`. */
  private refreshPreview(now = false) {
    this.syncPeek();
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
    if (!this.refused.has(this.keyOf(f))) {
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

  /** A cut with its own tool body previews inside the body it cuts, so that
   *  body is seen through for the drag. An auto push shows the pushed body
   *  itself, which is the thing to look at. */
  private syncPeek() {
    const f = this.pickingTarget || !this.faceIds.length ? null : this.buildFeature();
    const cut = f?.type === "press-pull" && f.operation === "cut" && this.mode !== "auto";
    const body = this.bodyId ?? this.viewport.faceIdToBodyId(this.faceIds[0] ?? -1);
    this.viewport.setPeek(cut && body ? () => [body] : null);
  }

  private buildGizmo() {
    this.handle = createDragHandle();
    this.gizmo = this.handle.group;
    this.viewport.addToScene(this.gizmo);
  }

  private hitGizmo(x: number, y: number): boolean {
    return this.handleAt(x, y) === "push";
  }

  /** The handle under the pointer, the taper arc first as the press tests
   *  them. One probe for both, so a finger's wider reach takes the handle
   *  under the touch before one beside it. */
  private handleAt(x: number, y: number): "taper" | "push" | null {
    const arc = this.taperArc;
    const gizmo = this.gizmo;
    if (!arc && !gizmo) return null;
    return this.viewport.probe(x, y, (rc) =>
      arc && rc.intersectObjects(arc.group.children, false).length > 0 ? "taper"
        : gizmo && rc.intersectObjects(gizmo.children, false).length > 0 ? "push" : null);
  }

  /** A taper is offered only where a wall exists to lean: a by-distance push
   *  that slides, with real travel. A resize has no wall, an up-to push lands on
   *  a chosen surface that a lean would miss, and a target-pick is mid-question. */
  private canTaper(): boolean {
    return !this.resizing && !this.upTo && !this.pickingTarget && this.direction === "normal" && Math.abs(this.value) >= PP_TAPER_MIN;
  }

  /** Float the curved taper arc above the pushed face, swinging in the plane the
   *  wall tips through. The same glyph and placement the extrude tool uses. */
  private placeTaperArc(dir: THREE.Vector3, k: number) {
    if (!this.canTaper()) {
      this.disposeTaperArc();
      return;
    }
    if (!this.taperArc) {
      this.taperArc = createRotationArc();
      this.viewport.addToScene(this.taperArc.group);
    }
    // A stable in-plane axis of the face: world X projected onto the face plane,
    // or world Y where the face faces along X.
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

  private modeToggle(): DimToggleDef {
    return {
      label: MODE_LABEL[this.mode],
      title: "Auto grows or shrinks the face; Join, Cut, New body and Intersect extrude it and combine with any body it reaches",
      initial: this.mode !== "auto",
      onChange: () => {
        this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length] ?? "auto";
        this.dim.setToggle(this.mode !== "auto");
        this.dim.setToggleLabel(MODE_LABEL[this.mode]);
        this.refreshPreview(true);
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

  /** Tangent faces follow applies to one round face with faces running into it. */
  private followOffered(): boolean {
    return this.faces.length === 1 && (this.round?.tangent?.faces ?? 0) > 0;
  }

  private syncToggle() {
    if (this.toggleKind === "follow") this.dim.setToggleHidden(!this.followOffered());
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
   *  signed push along the first face's outward normal, the arrow kept in place. */
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

  /** The "Along normal / Along axis" switch, hidden until the engine says the
   *  face has an axis. A fresh one per showing of the box, which clears its own. */
  private directionButton(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dim-btn dim-direction";
    btn.title = "Along axis slides the end of a hole down the hole, so the hole gets deeper and its end keeps its shape; Along normal offsets the face";
    btn.textContent = DIRECTION_LABEL[this.direction];
    btn.classList.toggle("on", this.direction === "axis");
    btn.style.display = this.holeAxis ? "" : "none";
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // never blur the input to press it
      e.stopPropagation();
      this.setDirection(this.direction === "axis" ? "normal" : "axis");
    });
    this.directionBtn = btn;
    return btn;
  }

  private askAxis(face: Selector, bodyId: string | null) {
    const ask = ++this.axisAsk;
    void this.store.faceAxis(face, bodyId).then((reply) => {
      if (ask !== this.axisAsk || !this.active || this.phase !== "drag") return;
      if (this.round) {
        this.adoptResize(offeredResize(reply), resizeAxis(reply));
        return;
      }
      this.holeAxis = offeredAxis(reply);
      if (!this.holeAxis) return;
      if (this.directionBtn) this.directionBtn.style.display = "";
      if (initialDirection(this.holeAxis) === "axis") this.setDirection("axis");
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
    if (this.neutral) this.promptNow();
    else this.refreshPreview(true);
  }

  private setDirection(d: PressPullDirection) {
    const axis = this.holeAxis;
    this.direction = d === "axis" && axis ? "axis" : "normal";
    if (this.directionBtn) {
      this.directionBtn.textContent = DIRECTION_LABEL[this.direction];
      this.directionBtn.classList.toggle("on", this.direction === "axis");
    }
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
    // A round face dragged past the smallest size the kernel will build is a
    // REMOVAL, not a very small cylinder. It commits as the same deleteFace the
    // Del key produces, so a shrunk-away hole heals exactly as a deleted one
    // does, and until this moment nothing has been committed at all, which is
    // what lets the user drag back out of it.
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
      // Taper rides a planar by-distance push only; the engine ignores it on a
      // curved face and on an up-to push, and it is written only when it bites.
      ...(!this.resizing && !this.upTo && this.direction === "normal" && Math.abs(this.taper) >= 0.05
        ? { taper: Math.round(this.taper * 1000) / 1000 }
        : {}),
    };
  }

  private commit() {
    if (this.phase !== "drag") return this.cancel();
    const v = this.dim.getValue("distance");
    const typed = this.dim.isUserDriven("distance");
    if (v == null && typed) {
      // the field holds unparseable text, committing the stale drag value
      // instead would be a silent wrong-number surprise
      setPrompt("That number can't be read · Esc");
      return;
    }
    if (typed && v != null && this.round && v < 0) {
      this.dim.flag(this.negativeSize());
      return;
    }
    // A typed ∠ is the truth for the taper, the same rule the distance follows.
    const tv = this.dim.getValue("taper");
    if (tv != null && this.dim.isUserDriven("taper")) {
      this.taper = Math.max(-MAX_PP_TAPER, Math.min(MAX_PP_TAPER, tv));
    }
    // Typed sign is preferred (out = +, cut = −), but ONLY when the user actually
    // typed. While dragging, the field displays |value|, so reading it back
    // unguarded strips a dragged cut's sign and commits a JOIN, the mirror image
    // of the typed-"-2"-after-outward-drag bug this line fixed.
    const want = typed && v != null ? this.fromReadout(v) : this.value;
    if (Math.abs(want - this.value) > 1e-6) {
      this.value = want;
      this.refreshPreview(true);
    } else {
      this.flushPreviewNow();
    }
    if (this.neutral) {
      // keep the tool alive: silently cancelling here read as "nothing happened"
      setPrompt(this.round ? `The ${this.full ? "diameter" : "radius"} is unchanged` : "Nothing to commit yet");
      return;
    }
    const k = this.keyOf(this.buildFeature());
    const decision = commitDecision({
      value: this.size(),
      verdict: this.refused.has(k) ? "refused" : this.built.has(k) ? "builds" : "unknown",
      settled: this.shownFeature !== null && this.keyOf(this.shownFeature) === k,
      shown: this.shown,
      typed,
      meaningful: (x) => Math.abs(x) >= MIN_PUSH,
    });
    if (decision.action === "stay") return this.promptNow();
    if (decision.action === "cancel") return this.cancel();
    this.value = decision.value;
    const feature = this.buildFeature();
    // Drop the live preview before the real add: it carries the same id, so
    // building both at once would duplicate it.
    if (this.enginePreviewOn) {
      this.store.setPreview(null);
      this.enginePreviewOn = false;
    }
    this.store.addFeature(feature);
    if (decision.unverified) this.store.verifyCommit(feature.id, "Press/Pull");
    this.cleanup();
    this.onDone?.(feature.id);
  }

  /** Commit an "extrude up to a surface", the engine derives each face's distance
   *  from the target, so we skip the near-zero-distance guard `commit()` applies. */
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

  private cleanup() {
    const el = this.viewport.domElement;
    this.gesture.detach();
    el.style.cursor = "default";
    this.clearPreviewTimer();
    this.unsubBuild?.();
    this.unsubBuild = null;
    this.forgetOutcomes();
    this.refusalShown = null;
    this.toggleKind = null;
    this.viewport.clearPressPullGhost();
    this.viewport.setPeek(null);
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
    this.grabbing = false;
    this.taperGrabbing = false;
    this.taperHovering = false;
    this.taper = 0;
    this.fluentGrab = false;
    this.hovering = false;
    this.value = 0;
    this.round = null;
    this.contact = null;
    this.resizing = false;
    this.axisAsk++;
    this.holeAxis = null;
    this.direction = "normal";
    this.directionBtn = null;
    setPrompt(null);
  }

  private disposeGizmo() {
    if (!this.gizmo || !this.handle) return;
    this.viewport.removeFromScene(this.gizmo);
    this.handle.dispose();
    this.gizmo = null;
    this.handle = null;
  }
}

/** The engine's refusal of a push, without the feature name it leads with. */
function refusalText(message: string): string {
  return message.replace(/^Press\/Pull[^:]*:\s*/i, "");
}
