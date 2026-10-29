// A datum plane's pose handles: an arrow for the offset and a ring per tilt and the spin (drawn by datumRings.ts).
// Each handle drives one field of document/datumPose.ts, so a tilted plane stays parametric, never a baked normal.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { PlaneDef, PlaneSpec } from "../types";
import { DimInput, type DimFieldDef } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { axisDragDistance, HANDLE_IDLE } from "./manipulator";
import { CanvasGesture } from "./canvasGesture";
import { angleDelta, angleInFrame, ringDragDegenerate, rotationFrame, snapDegrees } from "./transformGizmo";
import { RotateDial } from "../viewport/rotateDial";
import { SketchPlane } from "../sketch/plane";
import { pivotOf, placeDatum, turnAxes, type DatumPose, type PoseField } from "../document/datumPose";
import { DatumRings, RING_PX, type Grab, type RingScene } from "./datumRings";
import { HeldSignal } from "./heldEdit";

/** Degrees per step: the default, with Shift, and with Alt (free). */
export const TILT_STEP_DEG = 5;
export const TILT_FINE_DEG = 1;

export function tiltStep(e: { shiftKey: boolean; altKey: boolean }): number {
  return e.altKey ? 0 : e.shiftKey ? TILT_FINE_DEG : TILT_STEP_DEG;
}

/** Into (-180, 180], so a tilt dragged past half a turn reads the short way round. */
export function foldDegrees(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d + 0;
}

export interface PoseToolOptions {
  src: PlaneSpec;
  pose: DatumPose;
  /** fields a parameter expression drives, which get no handle and no box */
  locked?: ReadonlySet<PoseField>;
  /** set: an edit of a placed datum, its pose is written here on Enter instead of handed to onDone */
  onStep?: (pose: DatumPose) => void;
  /** every change while dragging or typing, for a live preview */
  onLive?: (pose: DatumPose) => void;
  /** draw a ghost of the plane (creating, where no real quad exists yet) */
  ghost: boolean;
}

/** `bySave` is set when a save entered the pose, so the caller adds the datum and skips what follows it. */
export type PoseDone = (pose: DatumPose | null, bySave?: boolean) => void;

export class DatumPoseTool {
  active = false;
  private opts: PoseToolOptions | null = null;
  private src = new SketchPlane("XY");
  private pose: DatumPose = { offset: 0, shiftX: 0, shiftY: 0, tiltX: 0, tiltY: 0, spin: 0 };
  /** the pose last handed out, so a click with nothing changed writes nothing */
  private stepped: DatumPose | null = null;

  handles: DatumRings | null = null;
  private ghostMesh: THREE.Mesh | null = null;
  private dialGroup = new THREE.Group();
  private dial: RotateDial | null = null;

  private hover: Grab | null = null;
  private grab: Grab | null = null;
  private grabValue = 0;
  private grabProj = 0;
  private grabAxis = new THREE.Vector3();
  private grabPivot = new THREE.Vector3();
  /** angular drag: the ring's own plane faces the camera enough to read an angle */
  private grabAngle: number | null = null;
  private lastAngle = 0;
  private turned = 0;
  /** linear drag: the handle is edge-on, so its screen tangent is read instead */
  private grabScreen = { x: 0, y: 0 };
  private tangentPx = new THREE.Vector2();
  private grabDialStart = 0;
  private downPos = { x: 0, y: 0 };
  private downOnGizmo = false;

  private dim = new DimInput();
  private onDone: PoseDone | null = null;
  private readonly gesture: CanvasGesture;
  private readonly held = new HeldSignal();

  constructor(private viewport: Viewport) {
    this.gesture = new CanvasGesture(viewport.domElement, {
      move: (e) => this.onMove(e),
      down: (e) => this.onDown(e),
      up: (e) => this.onUp(e),
      key: (e) => this.onKey(e),
      frame: () => this.tick(),
    });
  }

  start(opts: PoseToolOptions, onDone: PoseDone) {
    if (this.active) return;
    this.active = true;
    this.opts = opts;
    this.onDone = onDone;
    this.src = new SketchPlane(opts.src);
    this.pose = { ...opts.pose };
    this.stepped = { ...opts.pose };
    this.viewport.suspendPicking = true;
    this.gesture.attach();

    this.handles = new DatumRings((g) => !this.isLocked(g));
    this.viewport.addToScene(this.handles.group);
    this.viewport.addToScene(this.dialGroup);
    if (opts.ghost) this.buildGhost();

    const fields: DimFieldDef[] = (
      [
        { name: "offset", label: "Offset", kind: "length" },
        { name: "tiltX", label: "Tilt X", kind: "angle" },
        { name: "tiltY", label: "Tilt Y", kind: "angle" },
        { name: "spin", label: "Spin", kind: "angle" },
      ] as const
    )
      .filter((f) => !this.isLocked(f.name))
      .map((f) => ({ ...f }));
    this.dim.show(
      fields,
      () => this.finish(),
      () => this.cancel(),
    );
    this.dim.updateFromCursor({ ...this.pose });
    setPrompt(
      "Drag the arrow to offset, a ring to tilt or spin · 5° steps, Shift 1°, Alt free · type exact values · Enter · Esc",
    );
    this.refresh();
    this.gesture.frame();
  }

  private isLocked(f: PoseField): boolean {
    return !!this.opts?.locked?.has(f);
  }

  get placed(): PlaneDef {
    return placeDatum(this.src.spec, this.pose);
  }

  scene(): RingScene {
    const pivot = pivotOf(this.src.spec, this.pose);
    return {
      viewport: this.viewport,
      pivot,
      k: this.viewport.pixelWorldSize(pivot),
      src: this.src,
      plane: new SketchPlane(this.placed),
      axes: turnAxes(this.src.spec, this.pose),
      pose: this.pose,
      hover: this.hover,
      grab: this.grab,
    };
  }

  private onMove(e: PointerEvent) {
    const g = this.grab;
    if (g === "offset") {
      const base = pivotOf(this.src.spec, { ...this.pose, offset: 0 });
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, base, this.src.n);
      const raw = this.grabValue + (proj - this.grabProj);
      const v = snap(raw, this.viewport.snapStep(base, e.shiftKey));
      if (v === this.pose.offset) return;
      this.set({ offset: v });
      return;
    }
    if (g) {
      const delta = this.dragTurn(e.clientX, e.clientY);
      if (delta === null) return;
      const step = tiltStep(e);
      const v = foldDegrees(snapDegrees(this.grabValue + delta, step));
      this.dial?.update(this.grabDialStart, v - this.grabValue, step || 1);
      this.viewport.requestRender();
      if (Math.abs(v - this.pose[g]) < 1e-9) return;
      this.set({ [g]: v });
      return;
    }
    const h = this.hit(e.clientX, e.clientY);
    if (h !== this.hover) this.viewport.requestRender();
    this.hover = h;
    this.viewport.domElement.style.cursor = this.hover ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    const h = this.hit(e.clientX, e.clientY);
    this.downOnGizmo = h !== null;
    if (!h || !this.handles) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.dim.takeOver(h);
    this.grab = h;
    this.viewport.domElement.style.cursor = "grabbing";
    const s = this.scene();
    this.grabPivot.copy(s.pivot);
    if (h === "offset") {
      this.grabValue = this.pose.offset;
      const base = pivotOf(this.src.spec, { ...this.pose, offset: 0 });
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, base, this.src.n);
      return;
    }
    this.grabValue = this.pose[h];
    this.grabAxis.copy(s.axes[h]).normalize();
    const frame = rotationFrame(this.grabAxis);
    // Read off the same ray that found the ring: a finger's press may have hit it on one of probe's outer rays,
    // and the exact ray would miss the band and fall back to a made up starting angle.
    const handles = this.handles;
    const at =
      this.viewport.probe(e.clientX, e.clientY, (rc) => (handles.hit(rc) === h ? handles.grabbedAt(h, s, rc) : null)) ??
      handles.grabbedAt(h, s, this.viewport.rayFrom(e.clientX, e.clientY));
    this.grabDialStart = Math.atan2(at.dot(frame.v), at.dot(frame.u));
    this.grabScreen = { x: e.clientX, y: e.clientY };
    this.turned = 0;
    this.grabAngle = this.ringAngle(e.clientX, e.clientY);
    this.lastAngle = this.grabAngle ?? 0;
    if (this.grabAngle === null) {
      // Edge-on: the handle's circle is a line on screen, so read the drag along it.
      const p = s.pivot.clone().addScaledVector(at, RING_PX * s.k);
      const tan = this.grabAxis
        .clone()
        .cross(at)
        .multiplyScalar(RING_PX * s.k);
      const a = this.viewport.projectToScreen(p);
      const b = this.viewport.projectToScreen(p.clone().add(tan));
      this.tangentPx.set(b.x - a.x, b.y - a.y);
      if (this.tangentPx.length() < 6) {
        // A tilt seen from above moves straight at the viewer and its picture only shortens toward the pivot,
        // so a drag toward the pivot reads as toward the viewer.
        const o = this.viewport.projectToScreen(s.pivot);
        const view = this.viewport.camera.getWorldDirection(new THREE.Vector3());
        const inward = new THREE.Vector2(o.x - a.x, o.y - a.y);
        if (inward.lengthSq() < 1e-6) inward.set(0, -1);
        this.tangentPx.copy(inward.normalize().multiplyScalar(tan.dot(view) < 0 ? 1 : -1));
      }
    }
    this.dial = new RotateDial(this.grabAxis, HANDLE_IDLE);
    this.dial.update(this.grabDialStart, 0, tiltStep(e) || 1);
    this.dialGroup.add(this.dial.group);
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0) return;
    if (this.grab) {
      this.grab = null;
      this.dropDial();
      this.viewport.domElement.style.cursor = this.hover ? "grab" : "default";
      this.dim.focus();
      this.viewport.requestRender();
      return;
    }
    const moved = Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (!this.downOnGizmo && !moved) this.finish();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") this.cancel();
  }

  /** Degrees since the grab. */
  private dragTurn(x: number, y: number): number | null {
    if (this.grabAngle !== null) {
      const now = this.ringAngle(x, y);
      if (now === null) return null;
      this.turned += angleDelta(this.lastAngle, now);
      this.lastAngle = now;
      return (this.turned * 180) / Math.PI;
    }
    const len = this.tangentPx.length();
    if (len < 1e-6) return null;
    const along = ((x - this.grabScreen.x) * this.tangentPx.x + (y - this.grabScreen.y) * this.tangentPx.y) / len;
    return (along / RING_PX) * (180 / Math.PI);
  }

  private ringAngle(x: number, y: number): number | null {
    const view = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    if (ringDragDegenerate(view.dot(this.grabAxis))) return null;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.grabAxis, this.grabPivot);
    const at = this.viewport.screenToPlane(x, y, plane);
    if (!at) return null;
    return angleInFrame(at, this.grabPivot, rotationFrame(this.grabAxis));
  }

  hit(x: number, y: number): Grab | null {
    const handles = this.handles;
    if (!handles) return null;
    return this.viewport.probe(x, y, (rc) => handles.hit(rc));
  }

  private set(patch: Partial<DatumPose>) {
    this.pose = { ...this.pose, ...patch };
    this.dim.updateFromCursor(patch as Record<string, number>);
    this.refresh();
  }

  private refresh() {
    this.held.sync(this.pending);
    this.updateGhost();
    this.opts?.onLive?.({ ...this.pose });
    this.viewport.requestRender();
  }

  private tick() {
    if (!this.active || !this.handles) return;
    const s = this.scene();
    this.handles.place(s);
    this.dialGroup.position.copy(this.grab && this.grab !== "offset" ? this.grabPivot : s.pivot);
    this.dialGroup.scale.setScalar(s.k);
    if (this.dial) {
      this.dialGroup.updateMatrixWorld();
      this.dial.placeLabel((w) => this.viewport.projectToScreen(w));
    }
    const p = this.viewport.projectToScreen(s.pivot);
    this.dim.position(p.x + this.handles.fieldsAt, p.y);
    if (!this.grab) this.readTyped();
    this.gesture.frame();
  }

  /** A typed value is the truth once the user has typed it. */
  private readTyped() {
    const patch: Partial<DatumPose> = {};
    for (const f of ["offset", "tiltX", "tiltY", "spin"] as const) {
      if (!this.dim.isUserDriven(f)) continue;
      const v = this.dim.getValue(f);
      if (v != null && Math.abs(v - this.pose[f]) > 1e-9) patch[f] = v;
    }
    if (Object.keys(patch).length) {
      this.pose = { ...this.pose, ...patch };
      this.refresh();
    }
  }

  private changed(): boolean {
    const s = this.stepped;
    return !s || (Object.keys(this.pose) as (keyof DatumPose)[]).some((k) => Math.abs(this.pose[k] - s[k]) > 1e-9);
  }

  private step() {
    if (!this.changed()) return;
    this.stepped = { ...this.pose };
    this.opts?.onStep?.({ ...this.pose });
  }

  private buildGhost() {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd24a,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mat);
    m.renderOrder = 998;
    this.ghostMesh = m;
    this.viewport.addToScene(m);
  }

  private updateGhost() {
    if (!this.ghostMesh) return;
    const p = new SketchPlane(this.placed);
    this.ghostMesh.position.copy(p.origin);
    this.ghostMesh.quaternion.copy(p.orientation());
  }

  /** Enter, the tick box, a click off the handles, or a save. */
  private finish(bySave = false) {
    if (!this.active) return;
    this.readTyped();
    const pose = { ...this.pose };
    const editing = !!this.opts?.onStep;
    if (editing) this.step();
    const done = this.onDone;
    this.cleanup();
    done?.(editing ? null : pose, bySave);
  }

  /** A pose dragged or typed that Enter would write or hand out. */
  get pending(): boolean {
    return this.active && this.changed();
  }

  get dragging(): boolean {
    return this.grab !== null;
  }

  /** Told when `pending` turns on or off, for the unsaved mark and the close guard. */
  onHeldChange(fn: () => void): () => void {
    return this.held.on(fn);
  }

  /** For a save: the pose is written as Enter writes it. A drag still under the hand is left alone. */
  confirmHeld() {
    if (this.pending && !this.dragging) this.finish(true);
  }

  cancel() {
    const done = this.onDone;
    this.cleanup();
    done?.(null);
  }

  private dropDial() {
    this.dial?.dispose();
    this.dial = null;
  }

  private cleanup() {
    this.gesture.detach();
    this.viewport.domElement.style.cursor = "default";
    this.dim.hide();
    this.dropDial();
    if (this.handles) {
      this.viewport.removeFromScene(this.handles.group);
      this.handles.dispose();
      this.handles = null;
    }
    this.viewport.removeFromScene(this.dialGroup);
    if (this.ghostMesh) {
      this.viewport.removeFromScene(this.ghostMesh);
      this.ghostMesh.geometry.dispose();
      (this.ghostMesh.material as THREE.Material).dispose();
      this.ghostMesh = null;
    }
    this.viewport.suspendPicking = false;
    this.active = false;
    this.grab = null;
    this.hover = null;
    this.opts = null;
    setPrompt(null);
    this.held.sync(this.pending);
  }
}
