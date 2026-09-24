// A datum plane's pose on the canvas: an arrow for the offset, an arc for each
// tilt and one for the spin, all at the plane's pivot. Each handle drives exactly
// one field of the pose (document/datumPose.ts), which is what keeps a tilted
// plane parametric: dragging the tilt arc writes `tiltX`, never a baked normal.
//
// Used to create a datum (the pose is handed back on commit) and to edit one
// (every release is handed back as its own step while the handles stay up).

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { PlaneDef, PlaneSpec } from "../types";
import { DimInput, type DimFieldDef } from "../sketch/dimInput";
import { setPrompt } from "../ui/prompt";
import { snap } from "../ui/units";
import { axisDragDistance, createDragHandle, createRotationArc, HANDLE_IDLE, type DragHandle } from "./manipulator";
import { CanvasGesture } from "./canvasGesture";
import { angleDelta, angleInFrame, ringDragDegenerate, rotationFrame, snapDegrees } from "./transformGizmo";
import { RotateDial } from "../viewport/rotateDial";
import { SketchPlane } from "../sketch/plane";
import { pivotOf, placeDatum, turnAxes, type DatumPose, type PoseField } from "../document/datumPose";

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Degrees per step: the default, with Shift, and with Alt (free). */
export const TILT_STEP_DEG = 5;
export const TILT_FINE_DEG = 1;

export function tiltStep(e: { shiftKey: boolean; altKey: boolean }): number {
  return e.altKey ? 0 : e.shiftKey ? TILT_FINE_DEG : TILT_STEP_DEG;
}

/** An angle folded into (-180, 180], so a tilt dragged past half a turn reads as
 *  the short way round. */
export function foldDegrees(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d + 0;
}

/** How far out the arcs stand, in screen pixels: clear of the offset arrow and
 *  of each other, since each is a piece of the circle it turns the plane along. */
const ARC_RADIUS_PX = 64;
const SPIN_RADIUS_PX = 92;
const ARC_SWEEP = 1.4;
const radiusOf = (t: Turn) => (t === "spin" ? SPIN_RADIUS_PX : ARC_RADIUS_PX);
/** How much better, in pixels, the other side of the pivot has to be before an
 *  arc moves there, so it does not flicker as the view turns. */
const SIDE_HYSTERESIS_PX = 8;

type Turn = "tiltX" | "tiltY" | "spin";
type Grab = "offset" | Turn;
const TURNS: readonly Turn[] = ["tiltX", "tiltY", "spin"];

export interface PoseToolOptions {
  src: PlaneSpec;
  pose: DatumPose;
  /** false shows the offset arrow alone */
  turns: boolean;
  /** fields a parameter expression drives, which get no handle and no box */
  locked?: ReadonlySet<PoseField>;
  /** set: each release is handed here and the handles stay up (editing) */
  onStep?: (pose: DatumPose) => void;
  /** every change while dragging or typing, for a live preview */
  onLive?: (pose: DatumPose) => void;
  /** draw a ghost of the plane (creating, where no real quad exists yet) */
  ghost: boolean;
}

export class DatumPoseTool {
  active = false;
  private opts: PoseToolOptions | null = null;
  private src = new SketchPlane("XY");
  private pose: DatumPose = { offset: 0, shiftX: 0, shiftY: 0, tiltX: 0, tiltY: 0, spin: 0 };
  /** the pose last handed out, so a click with nothing changed writes nothing */
  private stepped: DatumPose | null = null;

  private arrow: DragHandle | null = null;
  private arcs = new Map<Turn, DragHandle>();
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
  /** linear drag: the arc is edge-on, so its screen tangent is read instead */
  private grabScreen = { x: 0, y: 0 };
  private tangentPx = new THREE.Vector2();
  private grabDialStart = 0;
  private downPos = { x: 0, y: 0 };
  private downOnGizmo = false;
  private moved = false;

  private dim = new DimInput();
  private onDone: ((pose: DatumPose | null) => void) | null = null;
  private readonly gesture: CanvasGesture;

  constructor(private viewport: Viewport) {
    this.gesture = new CanvasGesture(viewport.domElement, {
      move: (e) => this.onMove(e),
      down: (e) => this.onDown(e),
      up: (e) => this.onUp(e),
      key: (e) => this.onKey(e),
      frame: () => this.tick(),
    });
  }

  start(opts: PoseToolOptions, onDone: (pose: DatumPose | null) => void) {
    if (this.active) return;
    this.active = true;
    this.opts = opts;
    this.onDone = onDone;
    this.src = new SketchPlane(opts.src);
    this.pose = { ...opts.pose };
    this.stepped = { ...opts.pose };
    this.viewport.suspendPicking = true;
    this.gesture.attach();

    if (!this.isLocked("offset")) {
      this.arrow = createDragHandle();
      this.viewport.addToScene(this.arrow.group);
    }
    if (opts.turns) {
      for (const t of TURNS) {
        if (this.isLocked(t)) continue;
        const arc = createRotationArc("idle", { radius: radiusOf(t), sweep: ARC_SWEEP });
        this.arcs.set(t, arc);
        this.viewport.addToScene(arc.group);
      }
    }
    this.viewport.addToScene(this.dialGroup);
    if (opts.ghost) this.buildGhost();

    const fields: DimFieldDef[] = [];
    if (!this.isLocked("offset")) fields.push({ name: "offset", label: "Offset", kind: "length" });
    if (opts.turns) {
      if (!this.isLocked("tiltX")) fields.push({ name: "tiltX", label: "Tilt X", kind: "angle" });
      if (!this.isLocked("tiltY")) fields.push({ name: "tiltY", label: "Tilt Y", kind: "angle" });
      if (!this.isLocked("spin")) fields.push({ name: "spin", label: "Spin", kind: "angle" });
    }
    this.dim.show(fields, () => this.finish(), () => this.cancel());
    this.dim.updateFromCursor({ ...this.pose });
    setPrompt(
      opts.turns
        ? "Drag the arrow to offset, an arc to tilt or spin · 5° steps, Shift 1°, Alt free · type exact values · Enter · Esc"
        : "Drag or type an offset · Enter · Esc",
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

  // --- pointer ---------------------------------------------------------------

  private onMove(e: PointerEvent) {
    const g = this.grab;
    if (g === "offset") {
      const base = pivotOf(this.src.spec, { ...this.pose, offset: 0 });
      const proj = axisDragDistance(this.viewport, e.clientX, e.clientY, base, this.src.n);
      const raw = this.grabValue + (proj - this.grabProj);
      const v = snap(raw, this.viewport.snapStep(base, e.shiftKey));
      if (v === this.pose.offset) return;
      this.moved = true;
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
      this.moved = true;
      this.set({ [g]: v });
      return;
    }
    this.hover = this.hit(e.clientX, e.clientY);
    this.viewport.domElement.style.cursor = this.hover ? "grab" : "default";
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.downPos = { x: e.clientX, y: e.clientY };
    const h = this.hit(e.clientX, e.clientY);
    this.downOnGizmo = h !== null;
    if (!h) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.dim.takeOver(h);
    this.grab = h;
    this.moved = false;
    this.grabValue = this.pose[h];
    this.viewport.domElement.style.cursor = "grabbing";
    if (h === "offset") {
      const base = pivotOf(this.src.spec, { ...this.pose, offset: 0 });
      this.grabProj = axisDragDistance(this.viewport, e.clientX, e.clientY, base, this.src.n);
      return;
    }
    const axis = turnAxes(this.src.spec, this.pose)[h];
    this.grabAxis.copy(axis).normalize();
    this.grabPivot.copy(pivotOf(this.src.spec, this.pose));
    const frame = rotationFrame(this.grabAxis);
    const mid = this.arcMid(h);
    this.grabDialStart = Math.atan2(mid.dot(frame.v), mid.dot(frame.u));
    this.grabAngle = this.ringAngle(e.clientX, e.clientY);
    this.lastAngle = this.grabAngle ?? 0;
    this.turned = 0;
    if (this.grabAngle === null) {
      // Edge-on: the arc is a line on screen, so read the drag along it.
      this.grabScreen = { x: e.clientX, y: e.clientY };
      const k = this.viewport.pixelWorldSize(this.grabPivot);
      const at = this.grabPivot.clone().addScaledVector(mid, radiusOf(h) * k);
      const tan = this.grabAxis.clone().cross(mid).multiplyScalar(radiusOf(h) * k);
      const a = this.viewport.projectToScreen(at);
      const b = this.viewport.projectToScreen(at.clone().add(tan));
      this.tangentPx.set(b.x - a.x, b.y - a.y);
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
      if (this.moved && this.opts?.onStep) this.step();
      return;
    }
    const moved = Math.abs(e.clientX - this.downPos.x) > 3 || Math.abs(e.clientY - this.downPos.y) > 3;
    if (!this.downOnGizmo && !moved) this.finish();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") this.cancel();
  }

  /** The turn since the grab, in degrees. */
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
    return (along / radiusOf(this.grab as Turn)) * (180 / Math.PI);
  }

  private ringAngle(x: number, y: number): number | null {
    const view = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    if (ringDragDegenerate(view.dot(this.grabAxis))) return null;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.grabAxis, this.grabPivot);
    const at = this.viewport.screenToPlane(x, y, plane);
    if (!at) return null;
    return angleInFrame(at, this.grabPivot, rotationFrame(this.grabAxis));
  }

  private hit(x: number, y: number): Grab | null {
    const ray = this.viewport.rayFrom(x, y);
    if (this.arrow && ray.intersectObjects(this.arrow.group.children, false).length) return "offset";
    let best: { t: Turn; d: number } | null = null;
    for (const [t, arc] of this.arcs) {
      const h = ray.intersectObjects(arc.group.children, false)[0];
      if (h && (!best || h.distance < best.d)) best = { t, d: h.distance };
    }
    return best?.t ?? null;
  }

  // --- state -----------------------------------------------------------------

  private set(patch: Partial<DatumPose>) {
    this.pose = { ...this.pose, ...patch };
    this.dim.updateFromCursor(patch as Record<string, number>);
    this.refresh();
  }

  private refresh() {
    this.updateGhost();
    this.opts?.onLive?.({ ...this.pose });
    this.viewport.requestRender();
  }

  /** Which side of the pivot each arc stands on: the X tilt to the left on
   *  screen, the Y tilt to the right and the spin below, so the three never
   *  stack up whichever way the view is turned. Held still during a drag. */
  private sides: Record<Turn, number> = { tiltX: 1, tiltY: 1, spin: 0 };

  /** In-plane directions an arc may stand on: either way along the in-plane
   *  line square to a tilt's axis, or one of the four diagonals for the spin. */
  private candidates(t: Turn): THREE.Vector3[] {
    const p = new SketchPlane(this.placed);
    if (t === "spin") {
      return [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([a, b]) =>
        p.u.clone().multiplyScalar(a!).addScaledVector(p.v, b!).normalize());
    }
    const a = turnAxes(this.src.spec, this.pose)[t];
    const line = p.n.clone().cross(a);
    if (line.lengthSq() < 1e-9) line.copy(t === "tiltX" ? p.v : p.u);
    line.normalize();
    return [line, line.clone().negate()];
  }

  private arcMid(t: Turn): THREE.Vector3 {
    const c = this.candidates(t);
    return c[t === "spin" ? this.sides.spin : this.sides[t] > 0 ? 0 : 1]!.clone();
  }

  private chooseSides(pivot: THREE.Vector3, k: number) {
    const s0 = this.viewport.projectToScreen(pivot);
    const onScreen = (t: Turn, d: THREE.Vector3) => {
      const q = this.viewport.projectToScreen(pivot.clone().addScaledVector(d, radiusOf(t) * k));
      return { x: q.x - s0.x, y: q.y - s0.y };
    };
    const pick = (t: Turn, score: (p: { x: number; y: number }) => number, current: number) => {
      const scores = this.candidates(t).map((d) => score(onScreen(t, d)));
      let best = current;
      for (let i = 0; i < scores.length; i++) if (scores[i]! > scores[best]! + SIDE_HYSTERESIS_PX) best = i;
      return best;
    };
    this.sides.tiltX = pick("tiltX", (p) => -p.x, this.sides.tiltX > 0 ? 0 : 1) === 0 ? 1 : -1;
    this.sides.tiltY = pick("tiltY", (p) => p.x, this.sides.tiltY > 0 ? 0 : 1) === 0 ? 1 : -1;
    this.sides.spin = pick("spin", (p) => p.y, this.sides.spin);
  }

  private tick() {
    if (!this.active) return;
    const pivot = pivotOf(this.src.spec, this.pose);
    const k = this.viewport.pixelWorldSize(pivot);
    if (this.arrow) {
      const dir = this.src.n.clone().multiplyScalar(this.pose.offset < 0 ? -1 : 1);
      this.arrow.group.position.copy(pivot);
      this.arrow.group.quaternion.setFromUnitVectors(Y_AXIS, dir);
      this.arrow.group.scale.setScalar(k);
      this.arrow.paint({ hot: this.grab === "offset" || (!this.grab && this.hover === "offset") });
    }
    if (!this.grab) this.chooseSides(pivot, k);
    const axes = turnAxes(this.src.spec, this.pose);
    for (const [t, arc] of this.arcs) {
      const z = axes[t].clone().normalize();
      const y = this.arcMid(t);
      const x = y.clone().cross(z).normalize();
      arc.group.position.copy(pivot);
      arc.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      arc.group.scale.setScalar(k);
      arc.paint({ hot: this.grab === t || (!this.grab && this.hover === t) });
    }
    this.dialGroup.position.copy(this.grab && this.grab !== "offset" ? this.grabPivot : pivot);
    this.dialGroup.scale.setScalar(k);
    if (this.dial) {
      this.dialGroup.updateMatrixWorld();
      this.dial.placeLabel((w) => this.viewport.projectToScreen(w));
    }
    const s = this.viewport.projectToScreen(pivot);
    this.dim.position(s.x + SPIN_RADIUS_PX, s.y);
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

  // --- ghost -----------------------------------------------------------------

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

  // --- end -------------------------------------------------------------------

  /** Enter, the tick box, or a click off the handles. */
  private finish() {
    if (!this.active) return;
    this.readTyped();
    const pose = { ...this.pose };
    const editing = !!this.opts?.onStep;
    if (editing) this.step();
    const done = this.onDone;
    this.cleanup();
    done?.(editing ? null : pose);
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
    if (this.arrow) {
      this.viewport.removeFromScene(this.arrow.group);
      this.arrow.dispose();
      this.arrow = null;
    }
    for (const arc of this.arcs.values()) {
      this.viewport.removeFromScene(arc.group);
      arc.dispose();
    }
    this.arcs.clear();
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
  }
}
