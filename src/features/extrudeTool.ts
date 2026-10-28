// Interactive Extrude: pick profile areas (Ctrl-click adds, Enter confirms) and drag the depth along the normal. The
// operation is decided, never asked (extrudeOperation.ts); the prompt names it and Properties edits it afterwards.

import * as THREE from "three";
import { asFeature } from "../types";
import type { Viewport } from "../viewport/viewport";
import type { SketchOverlay, WorldRegion } from "../sketch/overlay";
import type { DocumentStore } from "../document/store";
import type { Feature } from "../types";
import { pointInRegion } from "../sketch/region";
import { DimInput } from "../sketch/dimInput";
import { escapeClaimed } from "../ui/escapeClaim";
import { isMenuKey } from "../ui/focus";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import {
  axisDragDistance,
  createDragHandle,
  nameHandle,
  createRotationArc,
  HANDLE_UP,
  type DragHandle,
} from "./manipulator";
import { draftAngle, draftDelta } from "./draftMath";
import { regionAnchor } from "./regionNudge";
import { OP_WORD, plannedOperation, type ExtrudeOp } from "./extrudeOperation";
import { sweepProbePoints } from "./sweepProbe";
import { previewVerdict } from "./previewVerdict";

/** Below this the extrude is straight: the frontend prism draws instantly and no kernel preview is asked for. */
const TAPER_EPS = 0.05;

/** Under this depth the taper lever, atan(inset / depth), is too short to read and no handle is offered. */
const TAPER_MIN_DEPTH = 1;

/** Degrees, just under the engine's refusal at 89 where a wall folds through itself. Not held to Draft's 60: an
 *  extrude taper has no neutral line to outswing, and a deep pocket wants steep walls. */
const MAX_TAPER_DEG = 88;

/** Pixels above the far face along the normal, clear of the depth handle's head (about 45px). */
const TAPER_ABOVE_PX = 48;

type Phase = "pick" | "drag";
type Op = ExtrudeOp;
const PINNED_CYCLE: readonly Op[] = ["new", "join", "cut"];

export class ExtrudeTool {
  active = false;
  private phase: Phase = "pick";
  private selected: WorldRegion[] = [];
  private distance = 10;
  /** `distance` each way off the plane. Reset on every entry since it belongs to the gesture, not the tool; an edit
   *  seeds it from the saved feature. */
  private symmetric = false;
  private preview: THREE.Group | null = null;
  private previewMat: THREE.MeshStandardMaterial | null = null;
  private previewKey = ""; // depth+sign+selection of the built preview geometry
  /** The same glyph as the taper, fillet and press/pull handles, drawn through the model so a cut's handle is not
   *  buried in the material it removes. */
  private depthHandle: DragHandle | null = null;
  private hovering = false;
  private grabbing = false;
  /** The drag is relative to it, so grabbing a 40 mm extrude does not snap it to the cursor's projection. */
  private grabValue = 0;
  private dim = new DimInput();
  private hitScratch = new THREE.Vector3();
  private onDone: ((id: string | null) => void) | null = null;

  private editId: string | null = null; // committed feature id being edited
  private editOp: Op | null = null; // saved operation, an edit keeps it rather than re-guessing
  private editHiddenBodies: string[] | undefined; // participants captured at creation, KEPT
  /** Forced visible while editing so its regions exist (consumed sketches hide), see main.ts's isSketchVisible. */
  forcedSketchId: string | null = null;
  /** A consumed sketch's second extrude sits on the solid its first made, so the guess would read Cut and shave that
   *  body. New body until Alt+O picks another. */
  private pinnedOp: Op | null = null;

  /** Lets the model view keep a handle on the last commit's far face that reopens this extrude; cleared once the user
   *  moves on. */
  lastCommit: { id: string; top: THREE.Vector3; dir: THREE.Vector3 } | null = null;

  /** Fluent grab: the cursor's projection along the normal at the press, so the depth grows from where you took
   *  hold. Null for every other entry, where the depth tracks the absolute projection. */
  private grabProj: number | null = null;
  private fluentGrab = false;
  /** Set once a drag lets go, so moving the hand to the box does not drag the depth along. */
  private depthHeld = false;
  private downPos = { x: 0, y: 0 };

  /** Degrees, positive narrows the far face. Zero is the plain straight prism. */
  private taper = 0;
  /** Only built once there is depth to swing about, never in edit mode (the Properties row edits a committed taper). */
  private taperHandle: DragHandle | null = null;
  private taperGuide: THREE.Line | null = null;
  /** The sketch's local +X. A drag of `inset` mm inward means atan(inset / depth). */
  private taperAxis = new THREE.Vector3(1, 0, 0);
  /** World point the taper handle floats beside: the centre of the far face. */
  private taperTop = new THREE.Vector3();
  private taperHovering = false;
  private taperGrabbing = false;
  private taperGrabProj = 0;
  private taperGrabInset = 0;
  /** One per gesture, shared by the engine preview and the committed feature, so a tapered preview replaces itself. */
  private previewId = "";
  /** The exact tapered solid is previewed through the engine (prism hidden), so going straight knows to clear it. */
  private taperPreviewOn = false;
  /** So an unchanged drag does not re-trigger an OCCT rebuild. */
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

  /** `opts.grabAt` is the direct entry (features/regionNudge.ts): arm from the pre-selection and start scrubbing in the
   *  same pointerdown. `opts.sketch` is a hidden, usually consumed, sketch shown for the gesture with every area
   *  selected, so a second extrude of it is a new feature. False when it has no closed area. */
  start(onDone: (id: string | null) => void, opts?: { grabAt?: { x: number; y: number }; sketch?: string }): boolean {
    if (this.active) return false;
    if (opts?.sketch) {
      this.forcedSketchId = opts.sketch;
      this.overlay.update(this.store.document);
      const points = this.overlay.regionPointsForSketch(opts.sketch);
      if (!points.length) {
        this.forcedSketchId = null;
        this.overlay.update(this.store.document);
        this.pinnedOp = null;
        return false;
      }
      this.overlay.selectRegionsByPoints(points);
      this.pinnedOp = "new";
    }
    // Read the pre-selection first: a handle whose regions have gone must not arm an unasked pick phase that holds
    // toolBusy() until noticed.
    const pre = this.overlay.selectedRegions();
    if (opts?.grabAt && !pre.length) return false;
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
    this.selected = pre;
    if (this.selected.length) {
      this.beginDrag();
      if (opts?.grabAt) this.grabHandle(opts.grabAt.x, opts.grabAt.y);
    } else {
      setPrompt("Click a profile · Ctrl-click adds areas · Enter");
    }
    return true;
  }

  /** The press that started the gesture landed on the passive selection handle before this tool existed. */
  private grabHandle(clientX: number, clientY: number) {
    const first = this.selected[0];
    if (this.phase !== "drag" || !first) return;
    this.fluentGrab = true;
    this.downPos = { x: clientX, y: clientY };
    this.grabProj = axisDragDistance(this.viewport, clientX, clientY, this.anchor(), first.plane.n);
    // Start at 0, not beginDrag's 10 mm: the depth is about to follow the hand, and a jump before the first move
    // would read as the grab doing something.
    this.distance = 0;
    this.updatePreview();
    this.viewport.domElement.style.cursor = "grabbing";
  }

  /** Rolls the model back before the extrude, forces its sketch visible and preselects its areas; commit replaces
   *  the feature in place (same id, one undo step). False when the distance is a parameter expression. */
  startEdit(
    featureId: string,
    onDone: (id: string | null) => void,
    opts?: { grabAt?: { x: number; y: number } },
  ): boolean {
    if (this.active) return false;
    const f = asFeature(
      this.store.document.features.find((x) => x.id === featureId),
      "extrude",
    );
    if (!f) return false;
    if (
      typeof f.distance !== "number" ||
      this.store.isParamBound({ kind: "feature", feature: f.id, field: "distance" })
    )
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
    // An edit needs pointerup too, or a taper or depth drag in it would never end.
    el.addEventListener("pointerup", this.boundUp);
    window.addEventListener("keydown", this.boundKey, true);

    // Roll back so previews and the op guess see the pre-extrude model, then rebuild the overlay so the forced
    // sketch contributes regions.
    this.store.beginEditPreview(featureId);
    this.overlay.update(this.store.document);
    const saved: [number, number, number][] = (f.regions ?? (f.region ? [f.region] : [])) as [number, number, number][];
    this.overlay.selectRegionsByPoints(saved);
    this.selected = this.overlay.selectedRegions();
    // A whole sketch extrude saved no region anchors, so an empty selection means the whole sketch: reselect every
    // area. Saved areas that no longer resolve really are lost and keep the prompt below.
    if (!this.selected.length && !saved.length) {
      this.overlay.selectRegionsByPoints(this.overlay.regionPointsForSketch(f.sketch));
      this.selected = this.overlay.selectedRegions();
    }
    if (this.selected.length) {
      this.beginDrag();
      const first = this.selected[0];
      if (opts?.grabAt && first) {
        const { x, y } = opts.grabAt;
        this.grabbing = true;
        this.grabValue = this.distance;
        this.downPos = { x, y };
        this.grabProj = axisDragDistance(this.viewport, x, y, this.anchor(), first.plane.n);
        this.viewport.domElement.style.cursor = "grabbing";
      }
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
      // A drag inward leans the walls in by atan(inset / depth), the same reading as a draft (draftMath).
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
      // A deliberate drag on the arrow beats a typed value (DimInput.seed's exception, takeOver()); without it a
      // reopened extrude could not be lengthened by hand.
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, anchor, plane.n);
      this.distance = this.grabValue + (proj - (this.grabProj ?? proj));
      this.dim.takeOver("distance");
      this.dim.updateFromCursor({ distance: Math.abs(this.distance) });
      this.positionDim(anchor);
      this.updatePreview();
      return;
    }
    // Not dragging, but the handles are targets: say so, or the only affordance is the depth following the cursor.
    this.taperHovering = this.hitTaper(e.clientX, e.clientY);
    this.hovering = !this.taperHovering && this.hitGizmo(e.clientX, e.clientY);
    const cur = this.viewport.domElement.style.cursor;
    if (this.hovering || this.taperHovering) this.viewport.domElement.style.cursor = "grab";
    else if (cur === "grab") this.viewport.domElement.style.cursor = "default";
    if (!this.dim.isUserDriven("distance") && !this.depthHeld && !this.hovering && !this.taperHovering) {
      // The depth tracks the cursor until it is over a handle; otherwise reaching for a handle moves it, and the
      // press commits instead of grabbing.
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, anchor, plane.n);
      // Relative once the handle is grabbed, absolute otherwise (grabProj).
      const d = this.grabProj == null ? proj : proj - this.grabProj;
      this.distance = d;
      this.dim.updateFromCursor({ distance: Math.abs(d) });
    } else if (this.dim.isUserDriven("distance")) {
      const v = this.dim.getValue("distance");
      if (v != null) this.distance = v; // the field is the truth: typed sign is preferred
    }
    // else hovering a handle: the depth holds so the handle can be grabbed.
    this.positionDim(anchor);
    this.updatePreview();
  }

  /** A value typed with the mouse still fires no pointermove, so this keeps the prompt and the operation read off it
   *  from lagging one word behind until Enter. */
  private onTypedDistance() {
    if (this.phase !== "drag" || !this.dim.isUserDriven("distance")) return;
    const v = this.dim.getValue("distance");
    if (v != null) this.distance = v;
    this.updatePreview();
  }

  /** At a stable spot by the selection centre, clamped inside the viewport; following the cursor made the box
   *  impossible to click. */
  private positionDim(anchor: THREE.Vector3 = this.anchor()) {
    const s = this.viewport.projectToScreen(anchor);
    const rect = this.viewport.domElement.getBoundingClientRect();
    const boxW = 160,
      boxH = 46,
      m = 12;
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
      // A plain click picks one area and goes to depth; Ctrl-click accumulates and Enter confirms.
      if (!additive && this.selected.length) this.beginDrag();
      return;
    }
    e.preventDefault();
    // The taper handle is tested first: it floats beside the depth arrow, and a drag on it swings the walls without
    // moving the depth.
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && this.hitTaper(e.clientX, e.clientY)) {
      e.stopImmediatePropagation();
      this.taperGrabbing = true;
      this.downPos = { x: e.clientX, y: e.clientY };
      // Freeze the depth when the taper is grabbed, or letting go and moving the hand would collapse the solid to the
      // pointer. The depth arrow takes it back (takeOver) for a deliberate depth drag.
      this.dim.seed("distance", this.distance);
      this.taperGrabInset = draftDelta(this.taper, Math.abs(this.distance), MAX_TAPER_DEG);
      this.taperGrabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.taperTop, this.taperAxis);
      this.viewport.domElement.style.cursor = "grabbing";
      return;
    }
    // Tested before the modifier and commit branches: a press on the handle starts a drag, never a commit.
    const grabFirst = this.selected[0];
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && grabFirst && this.hitGizmo(e.clientX, e.clientY)) {
      e.stopImmediatePropagation(); // don't orbit while dragging the handle
      this.grabbing = true;
      this.grabValue = this.distance;
      this.downPos = { x: e.clientX, y: e.clientY };
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, this.anchor(), grabFirst.plane.n);
      this.viewport.domElement.style.cursor = "grabbing";
      return;
    }
    // Ctrl-click keeps changing which areas even in the drag phase, so an edit can fix the areas it caught.
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const r = this.regionUnder(e.clientX, e.clientY);
      // A modifier click on empty space is a miss, not a commit; a commit on a miss turns a fix into a mistake.
      if (!r) return;
      this.overlay.toggleRegionSelection(r, true);
      this.selected = this.overlay.selectedRegions();
      if (!this.selected.length) {
        // Every area taken off: drop back to picking, since updatePreview returns early on an empty set and the
        // handles would float off nothing.
        this.phase = "pick";
        this.dim.hide();
        this.disposePreviewGeom();
        this.previewKey = "";
        this.disposeDepthHandle();
        this.disposeTaperHandle();
        this.clearPeek();
        setPrompt("Click a profile area · Esc");
        return;
      }
      this.positionDim();
      this.updatePreview();
      return;
    }
    this.commit();
  }

  /** A drag only ends on release, the depth it reached holds; a press on the depth arrow that never travelled
   *  still accepts the depth the cursor set. */
  private onUp(e: PointerEvent) {
    if (e.button !== 0 || this.phase !== "drag") return;
    const moved = Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (this.taperGrabbing) {
      this.taperGrabbing = false;
      this.viewport.domElement.style.cursor = this.taperHovering ? "grab" : "default";
      this.dim.focus();
      return;
    }
    if (this.grabbing) {
      this.grabbing = false;
      this.viewport.domElement.style.cursor = this.hovering ? "grab" : "default";
      if (!moved) return this.commit();
      this.depthHeld = true;
      this.dim.focus();
      return;
    }
    if (!this.fluentGrab) return;
    this.fluentGrab = false;
    this.viewport.domElement.style.cursor = "default";
    // A fluent press that never travelled opens the full tool with the depth still following the hand.
    if (moved) this.depthHeld = true;
    this.dim.focus();
  }

  private onKey(e: KeyboardEvent) {
    // Alt+S, checked before the typing guard since the depth field holds focus all drag; a bare s would eat a letter
    // from "millimeters", "inches" or "mils".
    if (e.altKey && (e.key === "s" || e.key === "S" || e.code === "KeyS") && this.phase === "drag") {
      e.preventDefault();
      e.stopPropagation();
      this.setSymmetric(!this.symmetric);
      return;
    }
    if (e.altKey && (e.key === "o" || e.key === "O" || e.code === "KeyO") && this.phase === "drag" && this.pinnedOp) {
      e.preventDefault();
      e.stopPropagation();
      this.pinnedOp = PINNED_CYCLE[(PINNED_CYCLE.indexOf(this.pinnedOp) + 1) % PINNED_CYCLE.length]!;
      this.promptKey = "";
      this.updatePreview();
      return;
    }
    if (isMenuKey(e) || (e.key === "Escape" && escapeClaimed())) return;
    if (this.dim.isActive && e.target instanceof HTMLInputElement) {
      if (e.key === "Escape") this.cancel();
      return;
    }
    if (e.key === "Escape") this.cancel();
    else if (e.key === "Enter" && this.phase === "pick" && this.selected.length) this.beginDrag();
  }

  /** The operation is recomputed: symmetric reaches material a one sided extrude pointed away from, and the prompt's
   *  cache is keyed only on depth and selection. */
  private setSymmetric(on: boolean) {
    if (this.symmetric === on) return;
    this.symmetric = on;
    this.dim.setToggle(on);
    this.promptKey = "";
    this.updatePreview();
  }

  private beginDrag() {
    this.phase = "drag";
    this.depthHeld = false;
    this.overlay.setHoverRegion(null);
    // One id per gesture, shared by the engine taper preview and the commit, so the preview replaces itself.
    this.previewId = this.editId ?? this.store.nextId();
    // A fresh gesture starts straight; an edit keeps its saved taper.
    this.taper = this.editId ? this.taper : 0;
    this.dim.show(
      // The ∠ field rides beside the depth; they never clobber each other, updateFromCursor only pushes `distance`.
      [
        { name: "distance", label: "D" },
        { name: "taper", label: "Angle", icon: "angle", kind: "angle" },
      ],
      () => this.commit(),
      () => this.cancel(),
      {
        label: "Symmetric",
        icon: "symmetric",
        title: "Sweep both ways off the sketch plane, this depth each way (Alt+S)",
        initial: this.symmetric,
        onChange: (on) => this.setSymmetric(on),
      },
      undefined,
      () => this.onTypedDistance(),
    );
    this.dim.updateFromCursor({ taper: this.taper });
    if (this.editId) {
      // Seed the signed distance and lock the field (userDriven), or free tracking would rewrite a saved depth on the
      // first move; dragging the arrow still overrides it (takeOver). Seeding the abs value would drop a cut's sign.
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

  /** Mean of the selected areas' interior points, shared with the passive handle (features/regionNudge.ts) so the
   *  arrow stays put across the hand-off. */
  private anchor(): THREE.Vector3 {
    return regionAnchor(this.selected);
  }

  /** Lets a preview keyed on depth and selection tell a real change from a repaint. */
  private selectionIds(): string {
    return this.selected
      .map((s) => `${s.sketchId}:${s.interior3D.x.toFixed(2)},${s.interior3D.y.toFixed(2)}`)
      .join("|");
  }

  private updatePreview() {
    if (!this.selected.length) return;
    this.refreshPrompt();
    // A typed ∠ is preferred over the last dragged taper, the same way a typed depth is.
    if (this.dim.isUserDriven("taper")) {
      const tv = this.dim.getValue("taper");
      if (tv != null) this.taper = Math.max(-MAX_TAPER_DEG, Math.min(MAX_TAPER_DEG, tv));
    }
    this.syncPeek();
    const sign = this.distance >= 0 ? 1 : -1;
    const depth = Math.abs(this.distance);
    // THREE.ExtrudeGeometry cannot taper, so a tapered extrude previews through the kernel like Draft: a new one via
    // store.setPreview, an edit via beginEditPreview(id, feature), varying the committed feature in place.
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

  private peekKey = "";

  /** See through the bodies the preview passes into, or a pocket hides inside opaque material. A cut counts every
   *  body its sweep box reaches: a tapered cut previews the pocket where a parity probe finds no material, and an
   *  edit starts on a model that may still hold the pocket. Anything else needs the probe to land in material. */
  private syncPeek() {
    const op = this.shownOp ?? this.plannedOperation();
    const key = `${op}:${this.distance.toFixed(1)}:${this.symmetric}:${this.selectionIds()}`;
    if (key === this.peekKey) return;
    this.peekKey = key;
    const points = sweepProbePoints(
      this.selected.map((wr) => ({
        interior: wr.interior3D,
        loop: wr.region.loop.map((p) => wr.plane.to3D(p.x, p.y)),
        normal: wr.plane.n,
      })),
      this.distance,
      this.symmetric,
    );
    const bounds = op === "cut";
    this.peeking = this.viewport.setPeek(() => this.viewport.bodiesHolding(points, bounds)).size > 0;
  }

  /** The prism is drawn over a ghosted body, so it has to be the stronger of the two. */
  private peeking = false;

  private clearPeek() {
    this.peekKey = "";
    this.peeking = false;
    this.viewport.setPeek(null);
  }

  /** A floating preview for a new extrude, a varied edit for a committed one. */
  private pushTaperPreview() {
    if (this.editId) this.store.beginEditPreview(this.editId, this.buildFeature());
    else this.store.setPreview(this.buildFeature());
  }

  /** A new extrude drops its floating preview, an edit returns to the rolled back model. */
  private clearTaperPreview() {
    if (this.editId) this.store.beginEditPreview(this.editId);
    else this.store.setPreview(null);
    this.taperPreviewOn = false;
    this.taperKey = "";
  }

  /** No kernel round trip, which makes depth dragging feel immediate. */
  private updatePrism(sign: number, depth: number) {
    const cut = this.drawsAsCut(sign);
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
        // Symmetric is one prism of twice the depth pulled back half its length in local space, so the same matrix
        // places it centred on the plane.
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
    if (this.previewMat) {
      this.previewMat.color.set(cut ? 0xff5c5c : 0x5b9bff);
      this.previewMat.opacity = this.peeking ? 0.75 : 0.5;
    }
  }

  /** Shown in both preview modes since they are controls, not geometry: one glyph pulled along the normal for depth
   *  and swung in plane for taper. */
  private updateManipulators(sign: number, depth: number) {
    const first = this.selected[0];
    if (!first) return;
    const plane = first.plane;
    const anchor = this.anchor();
    const dir = plane.n.clone().multiplyScalar(sign);
    const px = this.viewport.pixelWorldSize(anchor);
    // The centre of the far face, for one sided and symmetric alike (its near half sits a depth behind the plane).
    this.taperTop.copy(anchor).addScaledVector(dir, depth);

    if (!this.depthHandle) {
      this.depthHandle = nameHandle(createDragHandle(), "depth");
      this.viewport.addToScene(this.depthHandle.group);
    }
    // Red while the push removes material (a cut), amber while it adds.
    this.placeHandle(this.depthHandle, this.taperTop, dir, px, this.hovering || this.grabbing, this.drawsAsCut(sign));

    this.updateTaperHandle(plane, dir, px);
  }

  /** A rotation glyph, distinct from the depth handle's straight one. Offered once there is depth, for a new extrude
   *  and for one reopened by double-click. */
  private updateTaperHandle(plane: WorldRegion["plane"], dir: THREE.Vector3, px: number) {
    if (Math.abs(this.distance) < TAPER_MIN_DEPTH) {
      this.disposeTaperHandle();
      return;
    }
    if (!this.taperHandle) {
      this.taperHandle = nameHandle(createRotationArc(), "taper");
      this.viewport.addToScene(this.taperHandle.group);
    }
    // The sketch's local +X in world space, a deterministic in plane axis (moving the top edge in leans the wall in).
    const o = plane.to3D(0, 0);
    this.taperAxis.copy(plane.to3D(1, 0)).sub(o).normalize();
    const g = this.taperHandle.group;
    g.position.copy(this.taperTop).addScaledVector(dir, px * TAPER_ABOVE_PX);
    // The arc swings in the plane the wall tips through: local X along taperAxis, local Y up the normal, local Z the
    // plane's own normal.
    const z = new THREE.Vector3().crossVectors(this.taperAxis, dir).normalize();
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(this.taperAxis, dir, z));
    g.scale.setScalar(px);
    // Red once the walls undercut (a negative taper no mould can draw), amber otherwise.
    this.taperHandle.paint({
      hot: this.taperHovering || this.taperGrabbing,
      tone: this.taper < 0 ? "cut" : "idle",
    });
    this.updateTaperGuide(dir, z);
  }

  /** From the straight wall to the leaning one on the far face, so the angle reads on the model too. */
  private updateTaperGuide(dir: THREE.Vector3, swingNormal: THREE.Vector3) {
    if (Math.abs(this.taper) < 0.05) {
      this.disposeTaperGuide();
      return;
    }
    const depth = Math.abs(this.distance);
    const r = depth * 0.6;
    // On the wall that leans toward the centre: the profile's far side along the drag axis.
    const centre = this.taperTop.clone().addScaledVector(dir, -depth);
    let reach = 0;
    for (const wr of this.selected) {
      for (const q of wr.region.loop) reach = Math.max(reach, wr.plane.to3D(q.x, q.y).sub(centre).dot(this.taperAxis));
    }
    const base = centre.addScaledVector(this.taperAxis, reach);
    const rad = (this.taper * Math.PI) / 180;
    // Positive leans the far face in, toward the centre, so the wall tips away from taperAxis.
    const lean = (a: number) => dir.clone().applyAxisAngle(swingNormal, a).multiplyScalar(r).add(base);
    const steps = 24;
    const arc: THREE.Vector3[] = [];
    for (let i = 0; i <= steps; i++) arc.push(lean((rad * i) / steps));
    const pts = [base.clone(), lean(0), ...arc, lean(rad), base.clone()];
    if (!this.taperGuide) {
      const mat = new THREE.LineDashedMaterial({
        color: 0xffffff,
        dashSize: 1,
        gapSize: 1,
        transparent: true,
        opacity: 0.8,
        depthTest: false,
      });
      this.taperGuide = new THREE.Line(new THREE.BufferGeometry(), mat);
      this.taperGuide.renderOrder = 999;
      this.viewport.addToScene(this.taperGuide);
    }
    this.taperGuide.geometry.dispose();
    this.taperGuide.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.taperGuide.computeLineDistances();
    const dash = this.viewport.pixelWorldSize(base) * 5;
    const mat = this.taperGuide.material as THREE.LineDashedMaterial;
    mat.dashSize = dash;
    mat.gapSize = dash * 0.7;
  }

  private disposeTaperGuide() {
    if (!this.taperGuide) return;
    this.viewport.removeFromScene(this.taperGuide);
    this.taperGuide.geometry.dispose();
    (this.taperGuide.material as THREE.Material).dispose();
    this.taperGuide = null;
  }

  /** A negative depth reads as a cut unless an operation is pinned. */
  private drawsAsCut(sign: number): boolean {
    return this.pinnedOp ? this.pinnedOp === "cut" : sign < 0;
  }

  /** The one place both handles are placed, so they cannot drift into two shapes or two screen size rules. */
  private placeHandle(
    handle: DragHandle,
    at: THREE.Vector3,
    axis: THREE.Vector3,
    px: number,
    hot: boolean,
    cut: boolean,
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
    this.disposeTaperGuide();
    if (!this.taperHandle) return;
    this.viewport.removeFromScene(this.taperHandle.group);
    this.taperHandle.dispose();
    this.taperHandle = null;
  }

  /** Tested against the glyph's invisible grab volumes (the group's direct children), never the drawn shape, like
   *  every createDragHandle caller. */
  private hitGizmo(x: number, y: number): boolean {
    return this.handleAt(x, y) === "depth";
  }

  private hitTaper(x: number, y: number): boolean {
    return this.handleAt(x, y) === "taper";
  }

  /** The taper first, as the press tests them; one probe for both so a finger's wider reach takes the handle under
   *  the touch. */
  private handleAt(x: number, y: number): "taper" | "depth" | null {
    if (this.phase !== "drag") return null;
    const taper = this.taperHandle;
    const depth = this.depthHandle;
    if (!taper && !depth) return null;
    return this.viewport.probe(x, y, (rc) =>
      taper && rc.intersectObjects(taper.group.children, false).length > 0
        ? "taper"
        : depth && rc.intersectObjects(depth.group.children, false).length > 0
          ? "depth"
          : null,
    );
  }

  /** Also what the engine previews during a taper swing. `taper` is written only when it bites, so a plain extrude's
   *  JSON stays byte identical. */
  private buildFeature(): Feature {
    const first = this.selected[0]!;
    const hiddenBodies = this.editId ? this.editHiddenBodies : this.store.hiddenBodyIds();
    return {
      id: this.previewId,
      type: "extrude",
      sketch: first.sketchId,
      distance: Math.round(this.distance * 1000) / 1000,
      // shownOp is the word the prompt showed; reading it rather than recomputing keeps the two from disagreeing.
      operation: this.shownOp ?? this.plannedOperation(),
      regions: this.selected.map((wr) => [wr.interior3D.x, wr.interior3D.y, wr.interior3D.z]),
      ...(this.symmetric ? { symmetric: true } : {}),
      ...(Math.abs(this.taper) >= TAPER_EPS ? { taper: Math.round(this.taper * 1000) / 1000 } : {}),
      ...(hiddenBodies !== undefined ? { hiddenBodies } : {}),
    };
  }

  // Steps each area's interior a hair along the direction and asks the model, the one extrudeOperation.ts fact that
  // needs the scene. A drag sign guess made a push through the model a Join that silently did nothing.
  private entersSolid(): boolean {
    if (!this.selected.length) return false;
    const sign = this.distance >= 0 ? 1 : -1;
    let inside = 0;
    for (const wr of this.selected) {
      // Symmetric sweeps both ways, so either side entering counts; one side made a profile on a datum plane buried
      // in a body guess Join and add nothing.
      if (this.areaEnters(wr, sign) || (this.symmetric && this.areaEnters(wr, -sign))) inside++;
    }
    return inside * 2 > this.selected.length; // majority of selected areas
  }

  /** Once per area and direction per gesture: a tapered preview replaces the model, so probing again would find its
   *  own pocket and flip the operation every rebuild. */
  private entersMemo = new Map<string, boolean>();
  private areaEnters(wr: WorldRegion, dir: number): boolean {
    const p = wr.interior3D;
    const key = `${wr.sketchId}:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}:${dir}`;
    let hit = this.entersMemo.get(key);
    if (hit === undefined) {
      // step the area's interior a hair along the extrude direction, off its face
      hit = this.viewport.pointInSolid(p.clone().addScaledVector(wr.plane.n, dir * 0.05));
      this.entersMemo.set(key, hit);
    }
    return hit;
  }

  /** The situation features/extrudeOperation.ts reads, measured off the live model and selection. */
  private plannedOperation(): Op {
    return plannedOperation({
      savedOperation: this.editId ? this.editOp : this.pinnedOp,
      hasSolid: (this.store.buildState.result?.mesh.positions.length ?? 0) > 0,
      entersSolid: this.entersSolid(),
      allGlyphs: this.selected.length > 0 && this.selected.every((wr) => wr.entityId !== undefined),
    });
  }

  /** The operation on the prompt line, following the drag across zero. Gated on the depth's sign and the area count,
   *  since this runs every pointermove and plannedOperation() raycasts the whole model per area. */
  private shownOp: Op | null = null;
  private shownSym = false;
  private promptKey = "";
  private refreshPrompt() {
    if (this.phase !== "drag") return;
    const key = `${this.distance >= 0 ? "+" : "-"}${this.selected.length}${this.symmetric ? "s" : ""}`;
    if (key === this.promptKey) return;
    this.promptKey = key;
    const op = this.plannedOperation();
    // Symmetric is on the line too, so an unchanged word still repaints to announce the toggle.
    if (op === this.shownOp && this.symmetric === this.shownSym) return;
    this.shownOp = op;
    this.shownSym = this.symmetric;
    const word = OP_WORD[op];
    const sym = this.symmetric ? " · both ways (Alt+S)" : " · Alt+S symmetric";
    setPrompt(
      this.editId
        ? `${word} · Ctrl-click areas · drag or type a value${sym} · click to apply · Esc`
        : this.pinnedOp
          ? `${word} · Alt+O operation · drag or type a depth${sym} · side handle tapers · click to commit · Esc`
          : `${word} · drag or type a depth, negative cuts${sym} · side handle tapers · click to commit · Esc`,
    );
  }

  private commit() {
    if (!this.selected.length) return this.cancel();
    const v = this.dim.getValue("distance");
    // Only when typed: while dragging the field shows |distance|, and reading it back strips the sign so a cut goes
    // the wrong way ("Cut removed nothing").
    if (v != null && this.dim.isUserDriven("distance")) this.distance = v;
    if (Math.abs(this.distance) < 1e-3) return; // ignore zero
    // A typed ∠ is the truth for the taper, the same rule the depth follows.
    const tv = this.dim.getValue("taper");
    if (tv != null && this.dim.isUserDriven("taper")) {
      this.taper = Math.max(-MAX_TAPER_DEG, Math.min(MAX_TAPER_DEG, tv));
    }
    const first = this.selected[0];
    if (!first) return;
    // A typed value has not been previewed until the pointer moves, and the
    // kernel has to have seen the tapered solid before it can be judged.
    if (Math.abs(this.taper) >= 0.05) this.updatePreview();
    let unverified = false;
    if (this.taperPreviewOn) {
      const verdict = previewVerdict(this.store);
      unverified = verdict.kind === "wait";
      if (verdict.kind === "refused") {
        setPrompt(`Extrude refused: ${verdict.reason} · drag back or Esc`);
        this.depthHandle?.paint({ refused: true });
        this.viewport.requestRender();
        return;
      }
    }
    // A typed value with no drag never ran onMove, so refresh the prompt: buildFeature reads shownOp, so what is
    // built is the word on screen.
    this.refreshPrompt();
    // Shared with the live engine preview, so the commit is exactly what was on screen.
    const feature = this.buildFeature();
    const id = feature.id;
    const dir = first.plane.n.clone().multiplyScalar(this.distance >= 0 ? 1 : -1);
    this.lastCommit = {
      id,
      top: this.anchor().addScaledVector(dir, Math.abs(this.distance)),
      dir,
    };
    // A new extrude's floating taper preview carries the same id and would duplicate the write; an edit's goes with
    // endEditPreview below.
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
    if (unverified) this.store.verifyCommit(id, "Extrude");
    this.overlay.clearRegionSelection();
    this.cleanup();
    this.onDone?.(id);
  }

  cancel() {
    if (this.editId) this.store.endEditPreview();
    if (this.editId || this.forcedSketchId) this.overlay.clearRegionSelection();
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
    this.depthHeld = false;
    this.grabProj = null;
    this.dim.hide();
    this.disposePreviewGeom();
    this.previewMat?.dispose();
    this.previewMat = null;
    this.previewKey = "";
    this.disposeDepthHandle();
    this.disposeTaperHandle();
    this.clearPeek();
    this.entersMemo.clear();
    // A create mode cancel or commit can leave a floating taper preview up; an edit's goes with endEditPreview.
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
      this.pinnedOp = null;
      this.overlay.update(this.store.document); // re-hide the consumed sketch
    }
    setPrompt(null);
  }

  /** The material is reused. */
  private disposePreviewGeom() {
    if (!this.preview) return;
    this.viewport.removeFromScene(this.preview);
    for (const child of this.preview.children) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    this.preview = null;
  }
}
