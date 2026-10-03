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
import type { FaceAxisReply } from "../geometry/client";
import type { Feature, PressPullDirection, PressPullMode, Selector, Vec3 } from "../types";
import { DimInput, type DimChoice, type DimChoices, type DimFieldDef, type DimToggleDef } from "../sketch/dimInput";
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

const QUANTITIES: (DimChoice & { id: SizeQuantity })[] = [
  { id: "radius", label: "R", word: "Radius" },
  { id: "diameter", label: "Diameter", icon: "diameter", word: "Diameter" },
  { id: "offset", label: "Offset", word: "Offset" },
];

const CURVED = ["cylinder", "sphere", "cone", "torus"] as const;

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
  /** The engine's reading of a lone curved face the mesh fit did not take as a
   *  cylinder: a sphere, a cone or a torus, or a cylinder it missed. */
  private curve: OfferedResize | null = null;
  /** that face as a round face, a cylinder or a sphere, which it reads as
   *  along the normal; null on a cone or a torus */
  private curveRound: RoundFace | null = null;
  /** Some selected face is round, so the push resizes rather than slides:
   *  no taper, no boolean mode and no up to. Outlives `round` when a Ctrl-click
   *  adds a face outside its tangent run. */
  private resizing = false;
  /** What the size field reads for a round face, from its wrap until the user picks. */
  private quantity: SizeQuantity = "diameter";
  private quantityPicked = false;
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
  private guideAxis: ResizeAxis | null = null;
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
  /** What the kernel said about each push sent this gesture. */
  private outcomes = new PreviewOutcomes(/^Press\/Pull[^:]*:\s*/i);

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
      this.beginDrag(pre.selectors, pre.faceIds, pre.anchor, pre.normal, pre.bodyId, pre.round ?? pre.lead);
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
        const was = this.boxShape();
        const curved = this.curve !== null;
        this.faces.push(hit.selector);
        this.faceIds.push(hit.faceId);
        // The axis was the first face's; the faces share one arrow from here.
        this.axisAsk++;
        this.holeAxis = null;
        this.curve = null;
        this.curveRound = null;
        if (this.directionBtn) this.directionBtn.style.display = "none";
        if (this.direction === "axis") this.setDirection("normal");
        if (curved || this.viewport.roundFaceAt(hit.faceId, hit.anchor)) this.resizing = true;
        if (this.round && !this.inTangentRun()) this.dropRound();
        if (this.resizing) {
          this.mode = "auto";
          this.taper = 0;
        }
        if (was !== this.boxShape()) this.showBox();
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
    this.curve = null;
    this.curveRound = null;
    this.quantity = defaultQuantity(round?.full !== false);
    this.quantityPicked = false;
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
    this.promptNow();
    this.gesture.frame();
  }

  /** The value box for the current selection. The ∠ taper field rides beside
   *  the distance for a push that slides, the only one that leans a wall; a
   *  resize has none, and its free switch is Tangent faces follow instead of
   *  the boolean mode. */
  private showBox() {
    const defs: DimFieldDef[] = [{
      name: "distance",
      ...this.fieldLabel(),
      kind: "length",
      ...(this.round ? { choices: this.quantityChoices() } : {}),
    }];
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

  /** A pick from the menu shows the same size in the new terms; a typed one
   *  leaves the text alone, it is the value. */
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

  /** What the heads-up field shows for the current drag: the size a round face
   *  would become as a radius or a diameter (0 while the drag is asking for a
   *  full one to go) or how far it moves, the travelled distance on any other. */
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

  /** The typed value cannot be used: a minus on a size, or not yet a number.
   *  The drag value behind it is stale then, so nothing it would do is offered. */
  private typedUnusable(): { reason: string | null } | null {
    if (!this.dim.isUserDriven("distance")) return null;
    const v = this.dim.getValue("distance");
    if (v == null) return { reason: null };
    return this.absolute && v < 0 ? { reason: this.negativeSize() } : null;
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

  /** The instant cap of a resize or of a cone or torus offset, until the
   *  engine's own preview is on screen. Only over the model it was picked on:
   *  a preview renumbers the faces. */
  private refreshGhost() {
    const r = this.round;
    // A whole run moves each face along its own normal, a wall included, by the kernel's push.
    const run = !!r && this.faces.length > 1;
    const along = run || (!r && this.slant) ? "normal" : r;
    const k = this.neutral ? null : featureKey(this.buildFeature());
    if (!along || this.pickingTarget || this.outcomes.shownFeature || this.removing || k === null || this.outcomes.isRefused(k)) {
      this.viewport.clearPressPullGhost();
      return;
    }
    const push = run ? radialDrag(r.radius, this.value, r.solidInside, this.full).distance : this.value;
    this.viewport.setPressPullGhost(this.faceIds, push, along);
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
      setPrompt(`${this.outcomes.refusal} · ${then} · Esc`);
      return;
    }
    if (r) {
      const ask = this.quantity === "offset" ? "how far it moves, + is bigger" : `a ${this.quantity}`;
      const unusable = this.typedUnusable();
      if (unusable) {
        const why = unusable.reason;
        return setPrompt(why ? `${why[0]!.toUpperCase()}${why.slice(1)} · type another ${this.quantity} · Esc` : `Type ${ask} · Esc`);
      }
      // Nothing to ghost once the drag is asking for the face to GO; the
      // readout dropping to 0 and this line are what say so.
      if (this.removing) return setPrompt("Release to remove this face · drag back to keep it · Esc");
      const moves = this.followMoves();
      if (moves > 0) {
        return setPrompt(`Moves the ${moves === 1 ? "face that runs" : `${moves} faces that run`} smoothly into it · Esc`);
      }
      return setPrompt(this.full
        ? `Drag or type ${ask} · ${this.removalText(r)} removes it · Esc`
        : `Drag or type ${ask} · Esc`);
    }
    if (this.slant) return setPrompt("Drag or type how far it moves, negative cuts · Esc");
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

  /** Several faces that turned out not to be one round face's run push as one. */
  private leaveRun() {
    const was = this.boxShape();
    this.dropRound();
    if (was !== this.boxShape()) this.showBox();
    this.refreshPreview(true);
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
      const r = offeredResize(reply, CURVED);
      if (this.round && r?.kind === "cylinder") return this.adoptResize(r, resizeAxis(reply));
      if (this.faces.length > 1) return this.leaveRun();
      if (r && this.adoptCurve(r, reply)) return;
      if (this.round) return;
      this.holeAxis = offeredAxis(reply);
      if (!this.holeAxis) return;
      if (this.directionBtn) this.directionBtn.style.display = "";
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

  /** A face the mesh did not fit as a cylinder, read from the engine's answer.
   *  False when there is nothing in it to read. */
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
    if (this.directionBtn) this.directionBtn.style.display = this.holeAxis ? "" : "none";
    this.setDirection(initialDirection(this.holeAxis), was);
    return true;
  }

  /** A sphere, a cone or a torus read the way the push now goes: along the
   *  normal it resizes, about a sphere's centre or by an offset on a cone or a
   *  torus; along a hole's axis it slides like any end of a hole. */
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

  /** A cone or a torus offset along its normal where it was picked: it has no
   *  one size to read, so the field says how far it moves. */
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
    if (typed && v != null && this.absolute && v < 0) {
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
      setPrompt(this.round ? `The ${this.quantity === "offset" ? "size" : this.quantity} is unchanged` : "Nothing to commit yet");
      return;
    }
    const k = featureKey(this.buildFeature());
    const decision = commitDecision({
      value: this.size(),
      verdict: this.outcomes.verdict(k),
      settled: this.outcomes.settled(k),
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
    const reselect = (this.round || this.slant) && feature.type === "press-pull" && this.faces.length === 1
      ? this.faceAnchor.clone().addScaledVector(this.axis, this.value)
      : null;
    this.store.addFeature(feature);
    if (decision.unverified) this.store.verifyCommit(feature.id, "Press/Pull");
    this.cleanup();
    this.onDone?.(feature.id);
    if (reselect) this.reselectAfterBuild(feature.id, reselect);
  }

  /** Select the resized face where it now stands once the commit has built, so
   *  the next resize is one grab away. The viewport's own carry over of the
   *  selection looks where the face used to be. */
  private reselectAfterBuild(id: string, at: THREE.Vector3) {
    let started = false;
    // onBuild replays the current state at once, which is the model before the commit.
    const off = this.store.onBuild((s) => {
      if (s.building) { started = true; return; }
      if (!started || !s.result || s.previewBuilt) return;
      off();
      if (this.active || s.errorFeatureId === id) return;
      const face = this.viewport.faceIdNear([at.x, at.y, at.z]);
      if (face != null) this.viewport.selectOnlyFace(face);
    });
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
    this.outcomes.clear();
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
    this.curve = null;
    this.curveRound = null;
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
