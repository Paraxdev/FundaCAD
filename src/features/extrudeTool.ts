// Interactive Extrude (MCAD-style): select one or more profile AREAS, then set
// the distance by moving the cursor along the profile normal (live solid preview +
// arrow manipulator + numeric box). Areas can be pre-selected in the sketch or
// picked here: plain click picks one and starts the depth drag, Ctrl-click adds
// more (Enter to confirm the set). A ring (annulus) area previews/extrudes as a
// tube; selecting several areas unions them.
//
// The operation is DECIDED, never asked: New Body when nothing exists, Cut when
// the profile pushes into existing material, Join when it pulls away from it, a
// profile drawn on a face and pulled off it is the common case, and it joins. The
// commit used to stop on a four-way modal to have that answer confirmed, which
// put a decision in front of every extrude in order to change the few where the
// guess is wrong. The prompt names the operation while you drag instead, and
// Properties edits it afterwards (document/optionFields.ts has carried the row
// for a while), so the answer is both visible before and changeable after.

import * as THREE from "three";
import { asFeature } from "../types";
import type { Viewport } from "../viewport/viewport";
import type { SketchOverlay, WorldRegion } from "../sketch/overlay";
import type { DocumentStore } from "../document/store";
import type { Feature } from "../types";
import { pointInRegion } from "../sketch/region";
import { DimInput } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import {
  axisDragDistance,
  createDragHandle,
  fluentRelease,
  HANDLE_UP,
  type DragHandle,
} from "./manipulator";
import { draftAngle, draftDelta } from "./draftMath";
import { regionAnchor } from "./regionNudge";
import { OP_WORD, plannedOperation, type ExtrudeOp } from "./extrudeOperation";

/** Below this taper the extrude is treated as straight: the frontend prism draws
 *  instantly and no kernel preview is asked for. Above it the walls lean and the
 *  exact solid can only come from OCCT. */
const TAPER_EPS = 0.05;

/** A taper needs depth to swing about (angle = atan(inset / depth)); under this
 *  the lever is too short to read and the handle is not offered. */
const TAPER_MIN_DEPTH = 1;

/** Steepest taper the tool offers, degrees. Just under the sidecar's own limit
 *  (it refuses at or past 89, where a wall folds through itself), so a value the
 *  handle or field allows is always one the kernel will attempt. Unlike Draft
 *  this is not held to 60: an extrude taper has no neutral line to outswing, and
 *  a deep pocket wants the steeper walls. Whether a given profile survives that
 *  far is the kernel's call, surfaced as a readable refusal in the readout. */
const MAX_TAPER_DEG = 88;

/** How far off the top-centre the taper handle floats, in pixels: clear of the
 *  depth handle (which runs along the normal, perpendicular to this) and out
 *  where the wall it leans actually is. */
const TAPER_OFFSET_PX = 46;

type Phase = "pick" | "drag";
type Op = ExtrudeOp;

export class ExtrudeTool {
  active = false;
  private phase: Phase = "pick";
  private selected: WorldRegion[] = [];
  private distance = 10;
  /** Sweep both ways off the plane, `distance` each way. Off by default and
   *  reset on every entry, it is a property of the gesture you are making, not
   *  a mode the tool sits in. An EDIT seeds it from the saved feature. */
  private symmetric = false;
  private preview: THREE.Group | null = null;
  private previewMat: THREE.MeshStandardMaterial | null = null;
  private previewKey = ""; // depth+sign+selection of the built preview geometry
  /** The chunky slider at the far face you pull along the normal to set depth.
   *  The same glyph the taper handle, the fillet/chamfer and the press/pull tools
   *  use, its own generous invisible grab volumes and all, so the whole app grabs
   *  one shape. Its constant screen size and its being drawn THROUGH the model
   *  (so a cut's handle is not buried in the material it removes) come with it. */
  private depthHandle: DragHandle | null = null;
  private hovering = false;
  private grabbing = false;
  /** The distance at the moment the handle was taken hold of. The drag is
   *  relative to it, so grabbing an existing 40 mm extrude does not snap it to
   *  wherever the cursor happens to project. */
  private grabValue = 0;
  private dim = new DimInput();
  private hitScratch = new THREE.Vector3();
  private onDone: ((id: string | null) => void) | null = null;

  // --- edit mode (re-opening a committed extrude) ---
  private editId: string | null = null; // committed feature id being edited
  private editOp: Op | null = null; // saved operation, an edit keeps it rather than re-guessing
  private editHiddenBodies: string[] | undefined; // participants captured at creation, KEPT
  /** while editing, this sketch is forced visible so its regions exist
   *  (consumed sketches hide by default), main.ts's isSketchVisible honors it. */
  forcedSketchId: string | null = null;

  /** Fluent grab: the cursor's projection along the normal at the moment the
   *  passive handle was pressed. Null for every other entry, where the depth
   *  free-tracks the cursor's ABSOLUTE projection. Holding the button changes
   *  what the gesture means, the depth has to grow from where you took hold,
   *  not snap to wherever the arrow tip happened to project. */
  private grabProj: number | null = null;
  private fluentGrab = false;
  private downPos = { x: 0, y: 0 };

  // --- taper (lean the walls as the extrude climbs) ---
  /** Degrees, positive narrows the far face. Zero is the plain straight prism. */
  private taper = 0;
  /** The chunky slider you swing to set the taper, at the top rim of the solid.
   *  Only built once there is depth to swing about, and never in edit mode (the
   *  Properties row edits a committed taper). */
  private taperHandle: DragHandle | null = null;
  /** In-plane drag axis the taper handle runs along (the sketch's local +X). A
   *  drag of `inset` mm inward means atan(inset / depth). */
  private taperAxis = new THREE.Vector3(1, 0, 0);
  /** World point the taper handle floats beside: the centre of the far face. */
  private taperTop = new THREE.Vector3();
  private taperHovering = false;
  private taperGrabbing = false;
  private taperGrabProj = 0;
  private taperGrabInset = 0;
  /** Stable id for the sidecar preview AND the committed feature, one per gesture
   *  so a tapered preview replaces itself instead of piling up. */
  private previewId = "";
  /** true while the exact tapered solid is being previewed through the sidecar
   *  (the frontend prism is hidden), so the switch back to straight knows to
   *  clear it. */
  private taperPreviewOn = false;
  /** depth+sign+taper+selection of the tapered preview last asked of the sidecar,
   *  so an unchanged drag does not re-trigger an OCCT rebuild. */
  private taperKey = "";

  private boundMove: (e: PointerEvent) => void;
  private boundDown: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;

  constructor(
    private viewport: Viewport,
    private overlay: SketchOverlay,
    private store: DocumentStore,
  ) {
    this.boundMove = (e) => this.onMove(e);
    this.boundDown = (e) => this.onDown(e);
    this.boundUp = (e) => this.onUp(e);
    this.boundKey = (e) => this.onKey(e);
  }

  /** `opts.grabAt` is the direct-manipulation entry (features/regionNudge.ts):
   *  the user pressed the handle that appears the moment a profile is selected,
   *  so we arm from that pre-selection AND begin scrubbing inside the same
   *  pointerdown. */
  start(onDone: (id: string | null) => void, opts?: { grabAt?: { x: number; y: number } }) {
    if (this.active) return;
    // Read the pre-selection BEFORE installing anything: a handle whose regions
    // have gone (the sketch was hidden or re-solved between the paint and the
    // press) must not arm the pick phase, which would be a bait-and-switch into
    // a tool nobody asked for, holding toolBusy() until noticed.
    const pre = this.overlay.selectedRegions();
    if (opts?.grabAt && !pre.length) return;
    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.symmetric = false;
    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown);
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);
    // honour any areas pre-selected in the sketch
    this.selected = pre;
    if (this.selected.length) {
      this.beginDrag();
      if (opts?.grabAt) this.grabHandle(opts.grabAt.x, opts.grabAt.y);
    } else {
      setPrompt("Click a profile · Ctrl-click adds areas · Enter");
    }
  }

  /** Take hold of the arrow at (x, y) without a fresh pointerdown of our own,
   *  the press that started the gesture landed on the passive selection handle,
   *  before this tool existed. */
  private grabHandle(clientX: number, clientY: number) {
    const first = this.selected[0];
    if (this.phase !== "drag" || !first) return;
    this.fluentGrab = true;
    this.downPos = { x: clientX, y: clientY };
    this.grabProj = axisDragDistance(
      this.viewport,
      clientX,
      clientY,
      this.anchor(),
      first.plane.n,
    );
    // Start at nothing rather than at beginDrag's default 10 mm: the depth is
    // about to follow the hand that is already on the arrow, and a solid that
    // sprang to 10 mm before the first movement would read as the grab itself
    // having done something.
    this.distance = 0;
    this.updatePreview();
    this.viewport.domElement.style.cursor = "grabbing";
  }

  /** Re-open a committed extrude for editing: the model rolls back to just
   *  before it, its sketch is forced visible, the saved profile areas are
   *  pre-selected, and the saved distance seeds (and locks) the input, retype
   *  or Ctrl-click areas, then commit to REPLACE the feature in place (same id,
   *  one undo step). Returns false when the distance is a parameter expression
   *  (the value rows' job). */
  startEdit(featureId: string, onDone: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = asFeature(this.store.document.features.find((x) => x.id === featureId), "extrude");
    if (!f) return false;
    if (typeof f.distance !== "number" || this.store.isParamBound({ kind: "feature", feature: f.id, field: "distance" }))
      return false; // parameter-driven distance, the value rows' job

    this.active = true;
    this.phase = "pick";
    this.onDone = onDone;
    this.editId = featureId;
    this.editOp = f.operation;
    this.editHiddenBodies = f.hiddenBodies;
    this.distance = f.distance;
    this.symmetric = f.symmetric === true;
    this.taper = typeof f.taper === "number" ? f.taper : 0;
    this.forcedSketchId = f.sketch;

    this.viewport.suspendPicking = true;
    const el = this.viewport.domElement;
    el.addEventListener("pointermove", this.boundMove);
    el.addEventListener("pointerdown", this.boundDown);
    window.addEventListener("keydown", this.boundKey, true);

    // roll the model back so the pre-extrude state is what previews/op-guesses
    // see (exactly what the tool saw at creation), then rebuild the overlay so
    // the now-forced-visible sketch contributes regions to select from.
    this.store.beginEditPreview(featureId);
    this.overlay.update(this.store.document);
    const saved: [number, number, number][] = (
      f.regions ?? (f.region ? [f.region] : [])
    ) as [number, number, number][];
    this.overlay.selectRegionsByPoints(saved);
    this.selected = this.overlay.selectedRegions();
    // A whole-sketch extrude saved no region anchors, so there was nothing to
    // match and the selection is empty, which is NOT "its areas are gone", it is
    // the whole sketch. Reselect every area of it so the edit reopens previewing
    // and draggable, exactly as it was created. Only when NOTHING was saved:
    // an extrude that named specific areas which no longer resolve genuinely has
    // lost them, and that keeps the honest prompt below. Commit writes explicit
    // regions either way, as it always has, so this reselection changes no
    // geometry.
    if (!this.selected.length && !saved.length) {
      this.overlay.selectRegionsByPoints(this.overlay.regionPointsForSketch(f.sketch));
      this.selected = this.overlay.selectedRegions();
    }
    if (this.selected.length) {
      this.beginDrag();
    } else {
      setPrompt("Its areas are gone, click a profile · Esc");
    }
    return true;
  }

  private onMove(e: PointerEvent) {
    if (this.phase === "pick") {
      const r = this.regionUnder(e.clientX, e.clientY);
      this.overlay.setHoverRegion(r);
      this.viewport.domElement.style.cursor = r ? "pointer" : "default";
      return;
    }
    if (!this.selected.length) return;
    const first = this.selected[0];
    if (!first) return;
    const plane = first.plane;
    const anchor = this.anchor();
    if (this.taperGrabbing) {
      // Swing the far face over: a drag inward (against the handle's axis) leans
      // the walls in, and how far it leans per millimetre depends on the depth it
      // has to climb, exactly the atan(inset / lever) a draft reads (draftMath).
      const depth = Math.abs(this.distance);
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.taperTop, this.taperAxis);
      const inset = this.taperGrabInset + (this.taperGrabProj - proj);
      const stepped = snap(draftAngle(inset, depth, MAX_TAPER_DEG), e.shiftKey ? 0.1 : 1);
      this.taper = Math.max(-MAX_TAPER_DEG, Math.min(MAX_TAPER_DEG, stepped));
      this.dim.takeOver("taper"); // the handle owns the ∠ field while it is held
      this.dim.updateFromCursor({ taper: this.taper });
      this.updatePreview();
      return;
    }
    if (this.grabbing) {
      // A deliberate drag on the arrow outranks a typed value. That is the
      // exception DimInput.seed documents in as many words and takeOver()
      // exists for. Without it, re-opening an extrude to lengthen it by hand
      // was impossible: the seed locks the field, the lock stops cursor
      // tracking, and the arrow drawn right there did nothing at all.
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, anchor, plane.n);
      this.distance = this.grabValue + (proj - (this.grabProj ?? proj));
      this.dim.takeOver("distance");
      this.dim.updateFromCursor({ distance: Math.abs(this.distance) });
      this.positionDim(anchor);
      this.updatePreview();
      return;
    }
    // Not dragging, but the arrow and the taper handle are targets: say so, or
    // the only affordance is that the depth happens to follow the cursor.
    this.taperHovering = this.hitTaper(e.clientX, e.clientY);
    this.hovering = !this.taperHovering && this.hitGizmo(e.clientX, e.clientY);
    const cur = this.viewport.domElement.style.cursor;
    if (this.hovering || this.taperHovering) this.viewport.domElement.style.cursor = "grab";
    else if (cur === "grab") this.viewport.domElement.style.cursor = "default";
    if (!this.dim.isUserDriven("distance")) {
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, anchor, plane.n);
      // Relative once the handle has been grabbed, absolute otherwise, see
      // grabProj. Both come off the same projection; only the origin differs.
      const d = this.grabProj == null ? proj : proj - this.grabProj;
      this.distance = d;
      this.dim.updateFromCursor({ distance: Math.abs(d) });
    } else {
      const v = this.dim.getValue("distance");
      if (v != null) this.distance = v; // the field is the truth: typed sign wins
    }
    this.positionDim(anchor);
    this.updatePreview();
  }

  /** Park the depth input at a STABLE spot near the profile, anchored to the
   *  selection center (which doesn't move while you drag depth), offset off the
   *  geometry and clamped inside the viewport. Following the cursor made the box
   *  (and its buttons) impossible to click. */
  private positionDim(anchor: THREE.Vector3 = this.anchor()) {
    const s = this.viewport.projectToScreen(anchor);
    const rect = this.viewport.domElement.getBoundingClientRect();
    const boxW = 160, boxH = 46, m = 12;
    const fx = Math.max(rect.left + m, Math.min(s.x + 28, rect.right - boxW - m));
    const fy = Math.max(rect.top + m, Math.min(s.y + 28, rect.bottom - boxH - m));
    this.dim.position(fx - 16, fy - 16); // dim.position adds a +16 cursor offset
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.phase === "pick") {
      const r = this.regionUnder(e.clientX, e.clientY);
      if (!r) return;
      e.preventDefault();
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      this.overlay.toggleRegionSelection(r, additive);
      this.selected = this.overlay.selectedRegions();
      // plain click picks one area and goes straight to depth; Ctrl-click keeps
      // accumulating (Enter confirms the set)
      if (!additive && this.selected.length) this.beginDrag();
      return;
    }
    e.preventDefault();
    // Taking hold of the taper handle, tested first: it floats to the side of
    // the depth arrow and setting the lean is never a commit either. A drag on
    // it swings the walls; the depth stays put.
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && this.hitTaper(e.clientX, e.clientY)) {
      e.stopImmediatePropagation();
      this.taperGrabbing = true;
      this.downPos = { x: e.clientX, y: e.clientY };
      // Freeze the depth the instant the taper is taken hold of. Otherwise the
      // depth free-tracks the cursor, so letting go of the taper and moving the
      // hand would collapse the solid to wherever the pointer landed, which read
      // as the extrude closing the moment you tried to adjust the lean. The depth
      // arrow still takes it back (takeOver) for a deliberate depth drag.
      this.dim.seed("distance", this.distance);
      this.taperGrabInset = draftDelta(this.taper, Math.abs(this.distance), MAX_TAPER_DEG);
      this.taperGrabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.taperTop, this.taperAxis);
      this.viewport.domElement.style.cursor = "grabbing";
      return;
    }
    // Taking hold of the arrow, tested before the modifier and commit branches
    // below: a press on the handle is the start of a drag and never a commit,
    // and a tool whose handle committed on contact could not be used at all.
    const grabFirst = this.selected[0];
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && grabFirst
        && this.hitGizmo(e.clientX, e.clientY)) {
      e.stopImmediatePropagation(); // don't orbit while dragging the handle
      this.grabbing = true;
      this.grabValue = this.distance;
      this.downPos = { x: e.clientX, y: e.clientY };
      this.grabProj = axisDragDistance(
        this.viewport, e.clientX, e.clientY, this.anchor(), grabFirst.plane.n,
      );
      this.viewport.domElement.style.cursor = "grabbing";
      return;
    }
    // Ctrl-click keeps changing WHICH areas, even once the depth is being set.
    // The prompt has said "Ctrl-click areas" for as long as the edit flow has
    // existed and the tool did not honour it: every click in the drag phase
    // committed, the modified one included, so re-opening an extrude to fix
    // the areas it caught ended the moment you tried to.
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const r = this.regionUnder(e.clientX, e.clientY);
      // A modifier click on empty space is not a commit either: it is a miss,
      // and committing on a miss is how a correction becomes a mistake.
      if (!r) return;
      this.overlay.toggleRegionSelection(r, true);
      this.selected = this.overlay.selectedRegions();
      if (!this.selected.length) {
        // Every area taken off. There is nothing to extrude and nothing for the
        // handles to hang from, so drop back to picking rather than hold a drag
        // over an empty set. updatePreview early-returns on an empty set, so a
        // handle left alone would float in the air off nothing.
        this.phase = "pick";
        this.dim.hide();
        this.disposePreviewGeom();
        this.previewKey = "";
        this.disposeDepthHandle();
        this.disposeTaperHandle();
        setPrompt("Click a profile area · Esc");
        return;
      }
      this.positionDim();
      this.updatePreview();
      return;
    }
    this.commit();
  }

  /** Only the fluent gesture ends on a release. Every other entry keeps the
   *  free-track-then-click flow, where a pointerup is just the tail of the
   *  click that onDown already handled. */
  private onUp(e: PointerEvent) {
    if (e.button !== 0 || this.phase !== "drag") return;
    if (this.taperGrabbing) {
      // Letting go of the taper handle just stops the swing, it never commits:
      // the lean is one part of the extrude, not the whole of it, so the gesture
      // stays open for the depth or a clean click to finish.
      this.taperGrabbing = false;
      this.viewport.domElement.style.cursor = this.taperHovering ? "grab" : "default";
      return;
    }
    if (this.grabbing) {
      this.grabbing = false;
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      // A press that never travelled is the click it looks like, and a click in
      // this tool's drag phase commits, wherever it lands. Without this the
      // arrow would be the one place on screen where clicking to accept the
      // depth silently did nothing, which is worse than not being grabbable.
      const moved = Math.abs(e.clientX - this.downPos.x) > 3
        || Math.abs(e.clientY - this.downPos.y) > 3;
      if (!moved) this.commit();
      return;
    }
    if (!this.fluentGrab) return;
    const release = fluentRelease({
      fluent: true,
      moved: Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3,
      // The same threshold commit() uses to ignore a zero extrude.
      meaningful: Math.abs(this.distance) >= 1e-3,
    });
    // Cleared BEFORE dispatching, not in cleanup: commit() can decline and
    // leave the tool alive (a zero depth is ignored rather than committed), and
    // a stale flag would then make the NEXT release of any click re-run this
    // decision on a gesture that ended long ago.
    this.fluentGrab = false;
    if (release === "commit") return this.commit();
    if (release === "cancel") return this.cancel();
    // Stayed armed: a press that never travelled is the way IN to the full
    // tool. The depth keeps tracking relative to where the arrow was taken
    // hold of, which is exactly where the pointer still is, so nothing jumps.
    this.viewport.domElement.style.cursor = "default";
  }

  private onKey(e: KeyboardEvent) {
    // Alt+S, and checked BEFORE the typing guard below, because the depth field
    // holds focus for the whole drag and this has to work while it does. A chord
    // rather than a bare letter: the field takes spelled-out units, and
    // "millimeters", "inches" and "mils" all contain an s, so claiming the plain
    // key would eat a letter out of a legitimate value.
    if (e.altKey && (e.key === "s" || e.key === "S" || e.code === "KeyS") && this.phase === "drag") {
      e.preventDefault();
      e.stopPropagation();
      this.setSymmetric(!this.symmetric);
      return;
    }
    if (this.dim.isActive && e.target instanceof HTMLInputElement) {
      if (e.key === "Escape") this.cancel();
      return;
    }
    if (e.key === "Escape") this.cancel();
    else if (e.key === "Enter" && this.phase === "pick" && this.selected.length) this.beginDrag();
  }

  /** Turn Symmetric on or off from anywhere, and keep the box's switch with it.
   *
   *  The operation is recomputed rather than left alone: symmetric reaches
   *  material that a one-sided extrude was pointing away from, so the word on
   *  the prompt can change without the depth or the selection moving, which is
   *  what the prompt's own cache is keyed on. */
  private setSymmetric(on: boolean) {
    if (this.symmetric === on) return;
    this.symmetric = on;
    this.dim.setToggle(on);
    this.promptKey = "";
    this.updatePreview();
  }

  private beginDrag() {
    this.phase = "drag";
    this.overlay.setHoverRegion(null);
    // One id for the whole gesture: the sidecar taper preview and the committed
    // feature share it, so a live tapered preview replaces itself each rebuild
    // rather than accumulating a new body per drag step.
    this.previewId = this.editId ?? this.store.nextId();
    // A fresh gesture starts straight; an edit keeps whatever taper was saved
    // (the arrow is not offered in edit mode, so this only feeds the ∠ field).
    this.taper = this.editId ? this.taper : 0;
    this.dim.show(
      // The ∠ field rides beside the depth: the depth free-tracks the cursor,
      // the taper is set by its own handle or typed here, and the two never
      // clobber each other because updateFromCursor only ever pushes `distance`.
      [{ name: "distance", label: "D" }, { name: "taper", label: "∠", kind: "angle" }],
      () => this.commit(),
      () => this.cancel(),
      {
        label: "Symmetric",
        title: "Sweep both ways off the sketch plane, this depth each way (Alt+S)",
        initial: this.symmetric,
        onChange: (on) => this.setSymmetric(on),
      },
    );
    this.dim.updateFromCursor({ taper: this.taper });
    if (this.editId) {
      // seed the SIGNED saved distance and lock the field (userDriven): extrude's
      // onMove free-tracks the cursor and would clobber the seed on the first
      // move otherwise. So FREE tracking is off in edit mode, a hand that
      // happens to be moving must not rewrite a saved depth. Dragging the arrow
      // still works and outranks the seed, see onMove's grab branch: that is a
      // deliberate gesture on the handle that owns the field, which is the
      // exception DimInput.seed promises and takeOver() performs. (Seeding the
      // abs value would silently drop a cut's sign the moment getValue is read
      // back, the DimInput abs-display trap.)
      this.dim.seed("distance", this.distance);
    } else {
      this.distance = 10;
    }
    this.shownOp = null;
    this.promptKey = "";
    this.refreshPrompt();
    this.positionDim();
    this.updatePreview();
  }

  // --- geometry helpers ---
  /** the front-most region whose material (loop minus holes) contains the cursor */
  private regionUnder(cx: number, cy: number): WorldRegion | null {
    const ray = this.viewport.rayFrom(cx, cy).ray;
    let best: WorldRegion | null = null;
    let bestDist = Infinity;
    for (const wr of this.overlay.regions) {
      if (!ray.intersectPlane(wr.plane.plane, this.hitScratch)) continue;
      const p2d = wr.plane.to2D(this.hitScratch);
      if (!pointInRegion(p2d, wr.region)) continue;
      const d = ray.origin.distanceToSquared(this.hitScratch);
      if (d < bestDist) {
        bestDist = d;
        best = wr;
      }
    }
    return best;
  }

  /** average of the selected areas' interior points, the arrow anchor.
   *  Shared with the passive handle so the two arrows stand in the same place
   *  across the hand-off (features/regionNudge.ts). */
  private anchor(): THREE.Vector3 {
    return regionAnchor(this.selected);
  }

  /** A stable key for the selected areas, so a preview keyed on depth+selection
   *  can tell a real change from a repaint. */
  private selectionIds(): string {
    return this.selected
      .map((s) => `${s.sketchId}:${s.interior3D.x.toFixed(2)},${s.interior3D.y.toFixed(2)}`)
      .join("|");
  }

  private updatePreview() {
    if (!this.selected.length) return;
    this.refreshPrompt();
    // A typed ∠ wins over the last dragged taper, the same way a typed depth does.
    if (this.dim.isUserDriven("taper")) {
      const tv = this.dim.getValue("taper");
      if (tv != null) this.taper = Math.max(-MAX_TAPER_DEG, Math.min(MAX_TAPER_DEG, tv));
    }
    const sign = this.distance >= 0 ? 1 : -1;
    const depth = Math.abs(this.distance);
    // A leaning wall is not a prism, and THREE.ExtrudeGeometry cannot taper one,
    // so the instant frontend preview only serves the straight case. Once the
    // taper matters the exact solid comes from the kernel, exactly as Draft and
    // Press/Pull do: a NEW extrude previews through store.setPreview, an EDIT
    // through beginEditPreview(id, feature), which varies the committed feature
    // in place instead of stacking a second preview on the rolled-back model.
    const tapering = depth > 1e-6 && Math.abs(this.taper) >= TAPER_EPS;
    if (tapering) {
      this.disposePreviewGeom(); // the straight prism, if one is up, is now a lie
      this.previewKey = "";
      const key = `${depth.toFixed(3)}:${sign}:${this.taper.toFixed(2)}:${this.symmetric ? "s" : "o"}:${this.selectionIds()}`;
      if (key !== this.taperKey) {
        this.taperKey = key;
        this.pushTaperPreview();
      }
      this.taperPreviewOn = true;
    } else {
      if (this.taperPreviewOn) this.clearTaperPreview();
      this.updatePrism(sign, depth);
    }
    this.updateManipulators(sign, depth);
  }

  /** Send the exact tapered solid to the kernel: as a floating preview for a new
   *  extrude, as a varied edit for a committed one. */
  private pushTaperPreview() {
    if (this.editId) this.store.beginEditPreview(this.editId, this.buildFeature());
    else this.store.setPreview(this.buildFeature());
  }

  /** Take the tapered preview back down: a new extrude drops its floating
   *  preview, an edit returns to the rolled-back model the straight prism draws on. */
  private clearTaperPreview() {
    if (this.editId) this.store.beginEditPreview(this.editId);
    else this.store.setPreview(null);
    this.taperPreviewOn = false;
    this.taperKey = "";
  }

  /** The instant translucent prism for the STRAIGHT extrude, no kernel round-trip
   *  (that is what makes depth dragging feel immediate). */
  private updatePrism(sign: number, depth: number) {
    const cut = sign < 0;
    const key = `${depth.toFixed(3)}:${sign}:${this.symmetric ? "sym" : "one"}:${this.selectionIds()}`;
    if (key !== this.previewKey) {
      this.previewKey = key;
      this.disposePreviewGeom();
      if (!this.previewMat) {
        this.previewMat = new THREE.MeshStandardMaterial({
          transparent: true,
          opacity: 0.5,
          metalness: 0.1,
          roughness: 0.6,
        });
      }
      this.preview = new THREE.Group();
      for (const wr of this.selected) {
        const shape = new THREE.Shape(wr.region.loop.map((p) => p.clone()));
        for (const h of wr.region.holes) {
          shape.holes.push(new THREE.Path(h.map((p) => p.clone())));
        }
        // Symmetric is drawn as one prism of twice the depth pulled back half
        // its length, in LOCAL space before the basis is applied, so the same
        // one matrix still places it and the mesh really is centred on the
        // plane rather than two prisms that meet on it.
        const geo = new THREE.ExtrudeGeometry(shape, {
          depth: this.symmetric ? depth * 2 : depth,
          bevelEnabled: false,
          steps: 1,
        });
        if (this.symmetric) geo.translate(0, 0, -depth);
        geo.applyMatrix4(wr.plane.basisMatrix(sign)); // local +Z -> plane normal (flipped on cut)
        this.preview.add(new THREE.Mesh(geo, this.previewMat));
      }
      this.viewport.addToScene(this.preview);
    }
    this.previewMat?.color.set(cut ? 0xff5c5c : 0x5b9bff);
  }

  /** The two controls, the depth handle and the taper handle, shown in both
   *  preview modes because they are the controls and not the geometry. Both are
   *  the SAME glyph oriented to their own axis: pull the depth handle along the
   *  normal to set depth, swing the taper handle in-plane to lean the walls, so
   *  the two degrees of freedom read as one design. */
  private updateManipulators(sign: number, depth: number) {
    const first = this.selected[0];
    if (!first) return;
    const plane = first.plane;
    const anchor = this.anchor();
    const dir = plane.n.clone().multiplyScalar(sign);
    const px = this.viewport.pixelWorldSize(anchor);
    // The centre of the far face: the depth handle stands here (pull it along the
    // normal), the taper handle floats beside it. True for one-sided AND
    // symmetric, whose near half sits a depth behind the plane, so its far face
    // lands here too, and the taper drag measures its inward pull against it.
    this.taperTop.copy(anchor).addScaledVector(dir, depth);

    if (!this.depthHandle) {
      this.depthHandle = createDragHandle();
      this.viewport.addToScene(this.depthHandle.group);
    }
    // Red while the push removes material (a cut), amber while it adds.
    this.placeHandle(this.depthHandle, this.taperTop, dir, px, this.hovering || this.grabbing, sign < 0);

    this.updateTaperHandle(plane, px);
  }

  /** The chunky slider you swing to lean the walls, floating beside the far face.
   *  Offered once there is depth to swing about, for a new extrude AND for one
   *  reopened by double-click, so editing a taper is the same easy grab as making
   *  it. */
  private updateTaperHandle(plane: WorldRegion["plane"], px: number) {
    // A taper needs depth to swing about (angle = atan(inset / depth)); with too
    // little the lever is unreadable and the handle is not offered.
    if (Math.abs(this.distance) < TAPER_MIN_DEPTH) {
      this.disposeTaperHandle();
      return;
    }
    if (!this.taperHandle) {
      this.taperHandle = createDragHandle();
      this.viewport.addToScene(this.taperHandle.group);
    }
    // The sketch's local +X, in world space: a deterministic in-plane axis to
    // run the slider along and to measure the inward drag against.
    const o = plane.to3D(0, 0);
    this.taperAxis.copy(plane.to3D(1, 0)).sub(o).normalize();
    const at = this.taperTop.clone().addScaledVector(this.taperAxis, px * TAPER_OFFSET_PX);
    // Red once the walls undercut (a negative taper, which no mould can draw),
    // amber otherwise.
    this.placeHandle(this.taperHandle, at, this.taperAxis, px, this.taperHovering || this.taperGrabbing, this.taper < 0);
  }

  /** Orient, size, and tint one chunky slider at `at`, lying along `axis`. The
   *  one place the depth and taper handles are placed, so they cannot drift into
   *  two shapes or two screen-size rules: constant `pixelWorldSize` scale, glyph
   *  laid along its axis, amber or red for its state. */
  private placeHandle(
    handle: DragHandle, at: THREE.Vector3, axis: THREE.Vector3, px: number,
    hot: boolean, cut: boolean,
  ) {
    const g = handle.group;
    g.position.copy(at);
    g.quaternion.setFromUnitVectors(HANDLE_UP, axis);
    g.scale.setScalar(px);
    handle.paint({ hot, tone: cut ? "cut" : "idle" });
  }

  private disposeDepthHandle() {
    if (!this.depthHandle) return;
    this.viewport.removeFromScene(this.depthHandle.group);
    this.depthHandle.dispose();
    this.depthHandle = null;
  }

  private disposeTaperHandle() {
    if (!this.taperHandle) return;
    this.viewport.removeFromScene(this.taperHandle.group);
    this.taperHandle.dispose();
    this.taperHandle = null;
  }

  /** Is the cursor on the depth handle? Tested against the glyph's own generous
   *  invisible grab volumes (direct children of the group), never the drawn
   *  shape, the convention every createDragHandle caller shares. */
  private hitGizmo(x: number, y: number): boolean {
    if (!this.depthHandle || this.phase !== "drag") return false;
    return this.viewport.rayFrom(x, y).intersectObjects(this.depthHandle.group.children, false).length > 0;
  }

  /** Is the cursor on the taper handle? Same convention as the depth handle. */
  private hitTaper(x: number, y: number): boolean {
    if (!this.taperHandle || this.phase !== "drag") return false;
    return this.viewport.rayFrom(x, y).intersectObjects(this.taperHandle.group.children, false).length > 0;
  }

  /** The feature this gesture would commit (also what the sidecar previews while
   *  a taper is being swung). `taper` is written only when it bites, so a plain
   *  extrude's JSON is byte-identical to what earlier builds wrote. */
  private buildFeature(): Feature {
    const first = this.selected[0]!;
    const hiddenBodies = this.editId ? this.editHiddenBodies : this.store.hiddenBodyIds();
    return {
      id: this.previewId,
      type: "extrude",
      sketch: first.sketchId,
      distance: Math.round(this.distance * 1000) / 1000,
      operation: this.plannedOperation(),
      regions: this.selected.map((wr) => [wr.interior3D.x, wr.interior3D.y, wr.interior3D.z]),
      ...(this.symmetric ? { symmetric: true } : {}),
      ...(Math.abs(this.taper) >= TAPER_EPS ? { taper: Math.round(this.taper * 1000) / 1000 } : {}),
      ...(hiddenBodies !== undefined ? { hiddenBodies } : {}),
    };
  }

  // Does the extrude direction push INTO existing material? One of the four facts
  // features/extrudeOperation.ts reads, and the only one that needs the scene: it
  // steps each area's interior a hair along the direction and asks the model.
  //
  // This replaced a pure drag-SIGN guess, which defaulted "push a face through the
  // model" to Join and silently no-op'd (the union was already inside the body).
  private entersSolid(): boolean {
    if (!this.selected.length) return false;
    const sign = this.distance >= 0 ? 1 : -1;
    let inside = 0;
    for (const wr of this.selected) {
      // step the area's interior a hair along the extrude direction, off its face
      const p = wr.interior3D.clone().addScaledVector(wr.plane.n, sign * 0.05);
      // Symmetric sweeps BOTH ways, so it enters material if EITHER side does.
      // Reading one side is what made a profile on a datum plane buried in a
      // body guess Join, which then reported adding no material because the
      // prism was already inside the part.
      const q = this.symmetric
        ? wr.interior3D.clone().addScaledVector(wr.plane.n, -sign * 0.05)
        : null;
      if (this.viewport.pointInSolid(p) || (q !== null && this.viewport.pointInSolid(q))) inside++;
    }
    return inside * 2 > this.selected.length; // majority of selected areas
  }

  /** The situation the rules in features/extrudeOperation.ts read, measured off
   *  the live model and the live selection. Everything the commit modal used to
   *  pre-sort its list by, gathered in one place. */
  private plannedOperation(): Op {
    return plannedOperation({
      savedOperation: this.editId ? this.editOp : null,
      hasSolid: (this.store.buildState.result?.mesh.positions.length ?? 0) > 0,
      entersSolid: this.entersSolid(),
      allGlyphs: this.selected.length > 0 && this.selected.every((wr) => wr.entityId !== undefined),
    });
  }

  /** The operation, on the prompt line, following the drag across zero.
   *
   *  This is what replaced the commit dialog. The dialog's one honest job was
   *  saying which boolean you were about to get; a line that says so while you
   *  are still dragging does that job without stopping the gesture to do it.
   *
   *  Gated on the two things the answer can turn on, which side of zero the
   *  depth is, and how many areas are selected, because this runs on every
   *  pointermove and plannedOperation() casts a ray through the whole model per
   *  selected area. Nothing else moves during a drag: the model and the areas
   *  are fixed, and the depth's MAGNITUDE cannot change which boolean is meant.
   *  A dropped frame of a stale word is not a risk here; a raycast per area per
   *  move on an imported assembly is. */
  private shownOp: Op | null = null;
  private shownSym = false;
  private promptKey = "";
  private refreshPrompt() {
    if (this.phase !== "drag") return;
    const key = `${this.distance >= 0 ? "+" : "-"}${this.selected.length}${this.symmetric ? "s" : ""}`;
    if (key === this.promptKey) return;
    this.promptKey = key;
    const op = this.plannedOperation();
    // The symmetric state is on the line as well as the operation, so an
    // unchanged word does not skip a repaint that has to announce the toggle
    // the user just pressed.
    if (op === this.shownOp && this.symmetric === this.shownSym) return;
    this.shownOp = op;
    this.shownSym = this.symmetric;
    const word = OP_WORD[op];
    const sym = this.symmetric ? " · both ways (Alt+S)" : " · Alt+S symmetric";
    setPrompt(
      this.editId
        ? `${word} · Ctrl-click areas · drag or type a value${sym} · click to apply · Esc`
        : `${word} · drag or type a depth, negative cuts${sym} · side handle tapers · click to commit · Esc`,
    );
  }

  private commit() {
    if (!this.selected.length) return this.cancel();
    const v = this.dim.getValue("distance");
    // GATE on isUserDriven: while dragging, the field displays |distance|,
    // reading it back unconditionally strips the drag's sign and sends the
    // extrude the wrong way ("Cut removed nothing" on cut-toward-body).
    // Typed values (userDriven) carry their own sign and win.
    if (v != null && this.dim.isUserDriven("distance")) this.distance = v;
    if (Math.abs(this.distance) < 1e-3) return; // ignore zero
    // A typed ∠ is the truth for the taper, the same rule the depth follows.
    const tv = this.dim.getValue("taper");
    if (tv != null && this.dim.isUserDriven("taper")) {
      this.taper = Math.max(-MAX_TAPER_DEG, Math.min(MAX_TAPER_DEG, tv));
    }
    const first = this.selected[0];
    if (!first) return;
    // Feature construction (id, regions, symmetric, taper, captured participants)
    // is shared with the live sidecar preview, so the thing committed is exactly
    // the thing that was on screen. See buildFeature.
    const feature = this.buildFeature();
    const id = feature.id;
    // Drop any live taper preview before the real write. A new extrude's floating
    // preview carries the same id, so building both at once would duplicate it;
    // an edit's preview is torn down by endEditPreview below instead.
    if (this.taperPreviewOn) {
      if (!this.editId) this.store.setPreview(null);
      this.taperPreviewOn = false;
      this.taperKey = "";
    }
    if (this.editId) {
      this.store.endEditPreview(false); // replaceFeature triggers the rebuild
      this.store.replaceFeature(this.editId, feature);
    } else {
      this.store.addFeature(feature);
    }
    this.overlay.clearRegionSelection();
    this.cleanup();
    this.onDone?.(id);
  }

  cancel() {
    if (this.editId) {
      this.store.endEditPreview();
      this.overlay.clearRegionSelection();
    }
    this.cleanup();
    this.onDone?.(null);
  }

  private cleanup() {
    const el = this.viewport.domElement;
    el.removeEventListener("pointermove", this.boundMove);
    el.removeEventListener("pointerdown", this.boundDown);
    el.removeEventListener("pointerup", this.boundUp);
    window.removeEventListener("keydown", this.boundKey, true);
    el.style.cursor = "default";
    this.fluentGrab = false;
    this.grabProj = null;
    this.dim.hide();
    this.disposePreviewGeom();
    this.previewMat?.dispose();
    this.previewMat = null;
    this.previewKey = "";
    this.disposeDepthHandle();
    this.disposeTaperHandle();
    // A create-mode cancel or commit can leave a live floating taper preview up;
    // drop it so the model returns to what is actually committed. An edit's taper
    // preview is torn down by endEditPreview in cancel()/commit() instead.
    if (this.taperPreviewOn && !this.editId) this.store.setPreview(null);
    this.taperPreviewOn = false;
    this.taperKey = "";
    this.taper = 0;
    this.taperGrabbing = false;
    this.taperHovering = false;
    this.hovering = false;
    this.grabbing = false;
    this.overlay.setHoverRegion(null);
    this.viewport.suspendPicking = false;
    this.active = false;
    this.symmetric = false;
    this.selected = [];
    if (this.editId !== null || this.forcedSketchId !== null) {
      this.editId = null;
      this.editOp = null;
      this.editHiddenBodies = undefined;
      this.forcedSketchId = null;
      this.overlay.update(this.store.document); // re-hide the consumed sketch
    }
    setPrompt(null);
  }

  /** remove + dispose the preview group's geometries (the material is reused) */
  private disposePreviewGeom() {
    if (!this.preview) return;
    this.viewport.removeFromScene(this.preview);
    for (const child of this.preview.children) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    this.preview = null;
  }
}
