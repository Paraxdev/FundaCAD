// Draws and hit tests a datum plane's pose handles: the offset arrow and rings about the reference x (tiltX), the y
// that leaves (tiltY) and the plane's normal (spin). The pose tool owns the drag.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DatumPose } from "../document/datumPose";
import type { SketchPlane } from "../sketch/plane";
import { createDragHandle, nameHandle, leanOutOfView, type DragHandle } from "./manipulator";
import { createSlimRing, ringLook, type SlimRing } from "./slimRing";
import { axisColor, type AxisKey } from "../viewport/originTriad";

export type Turn = "tiltX" | "tiltY" | "spin";
export type Grab = "offset" | Turn;
export const TURNS: readonly Turn[] = ["tiltX", "tiltY", "spin"];

export const RING_PX = 62;
/** Share of the offset arrow still shown with the normal at the camera, so it keeps a length to aim at from the top. */
const ARROW_MIN_SCREEN = 0.7;

// The move gizmo's axis colours, so a tilt about x reads as the same colour as sliding along x.
const RING_NAME: Record<Turn, string> = { tiltX: "tilt x", tiltY: "tilt y", spin: "spin" };
const RING_AXIS: Record<Turn, AxisKey> = { tiltX: "x", tiltY: "y", spin: "z" };
const UP = new THREE.Vector3(0, 1, 0);

/** Rebuilt by the tool every frame. */
export interface RingScene {
  viewport: Viewport;
  pivot: THREE.Vector3;
  /** world units per screen pixel at the pivot */
  k: number;
  /** the reference the pose is measured from */
  src: SketchPlane;
  /** the plane as the pose places it now */
  plane: SketchPlane;
  axes: Record<Turn, THREE.Vector3>;
  pose: DatumPose;
  hover: Grab | null;
  grab: Grab | null;
}

export class DatumRings {
  readonly group = new THREE.Group();
  /** how far right of the pivot the value boxes stand, in screen pixels */
  readonly fieldsAt = RING_PX + 30;
  arrow: DragHandle | null = null;
  rings = new Map<Turn, SlimRing>();
  /** a faint outline round the three, so they read as one ball */
  private rim: THREE.Line;

  constructor(offers: (g: Grab) => boolean) {
    if (offers("offset")) {
      this.arrow = nameHandle(createDragHandle(), "arrow");
      this.group.add(this.arrow.group);
    }
    for (const t of TURNS) {
      if (!offers(t)) continue;
      const r = createSlimRing(RING_PX);
      nameHandle(r.group, RING_NAME[t]);
      this.rings.set(t, r);
      this.group.add(r.group);
    }
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * (RING_PX + 0.5), Math.sin(a) * (RING_PX + 0.5), 0));
    }
    this.rim = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.16,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.rim.renderOrder = 997;
    this.group.add(this.rim);
  }

  place(s: RingScene) {
    const cam = s.viewport.camera;
    if (this.arrow) {
      const fwd = cam.getWorldDirection(new THREE.Vector3());
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      const n = s.src.n.clone().multiplyScalar(s.pose.offset < 0 ? -1 : 1);
      const dir = leanOutOfView(n, fwd, right.add(up).multiplyScalar(-1).normalize(), ARROW_MIN_SCREEN);
      this.arrow.group.position.copy(s.pivot);
      this.arrow.group.quaternion.setFromUnitVectors(UP, dir);
      this.arrow.group.scale.setScalar(s.k);
      this.arrow.paint({ hot: s.grab === "offset" || (!s.grab && s.hover === "offset") });
    }
    for (const [t, r] of this.rings) {
      const z = s.axes[t].clone().normalize();
      const y = t === "spin" ? s.plane.v.clone() : s.plane.n.clone().projectOnPlane(z);
      if (y.lengthSq() < 1e-9) y.copy(s.plane.u).projectOnPlane(z);
      y.normalize();
      r.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(y.clone().cross(z), y, z));
      r.group.position.copy(s.pivot);
      r.group.scale.setScalar(s.k);
      r.paint(ringLook(t as Grab, s.hover, s.grab, TURNS), axisColor(RING_AXIS[t]));
    }
    this.rim.position.copy(s.pivot);
    this.rim.quaternion.copy(cam.quaternion);
    this.rim.scale.setScalar(s.k);
    this.rim.visible = !s.grab;
  }

  hit(ray: THREE.Raycaster): Grab | null {
    if (this.arrow && ray.intersectObjects(this.arrow.group.children, false).length) return "offset";
    let best: { t: Turn; d: number } | null = null;
    for (const [t, r] of this.rings) {
      const h = ray.intersectObject(r.band, false)[0];
      if (h && (!best || h.distance < best.d)) best = { t, d: h.distance };
    }
    return best?.t ?? null;
  }

  /** Where on turn `t`'s circle a press along `ray` took hold, as a unit
   *  direction from the pivot square to the turn's axis. */
  grabbedAt(t: Turn, s: RingScene, ray: THREE.Raycaster): THREE.Vector3 {
    const axis = s.axes[t].clone().normalize();
    const r = this.rings.get(t);
    const h = r ? ray.intersectObject(r.band, false)[0] : undefined;
    const at = h ? h.point.clone().sub(s.pivot).projectOnPlane(axis) : new THREE.Vector3();
    if (at.lengthSq() < 1e-12) at.copy(s.plane.n).projectOnPlane(axis);
    if (at.lengthSq() < 1e-12) at.copy(s.plane.u).projectOnPlane(axis);
    return at.normalize();
  }

  /** For measuring: the point of `g` a press takes that stands farthest on screen from the other rings, and what
   *  it draws. */
  probe(g: Grab, s: RingScene): { grabAt: THREE.Vector3; drawn: THREE.Object3D[] } | null {
    this.group.updateMatrixWorld(true);
    if (g === "offset") {
      return this.arrow
        ? { grabAt: this.arrow.group.localToWorld(new THREE.Vector3(0, 30, 0)), drawn: [this.arrow.group] }
        : null;
    }
    const r = this.rings.get(g);
    if (!r) return null;
    const circle = (n: number) =>
      Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * RING_PX, Math.sin(a) * RING_PX, 0);
      });
    const others = [...this.rings.entries()]
      .filter(([t]) => t !== g)
      .flatMap(([, o]) => circle(48).map((p) => s.viewport.projectToScreen(o.group.localToWorld(p))));
    // Only the near half: seen edge-on a ring is a line, and a press on it takes
    // the side facing the viewer.
    const view = s.viewport.camera.getWorldDirection(new THREE.Vector3());
    let best = r.group.position.clone();
    let far = -Infinity;
    for (const p of circle(72)) {
      const w = r.group.localToWorld(p);
      if (w.clone().sub(s.pivot).dot(view) > 1e-6 * s.k) continue;
      const q = s.viewport.projectToScreen(w);
      const d = Math.min(400, ...others.map((o) => Math.hypot(o.x - q.x, o.y - q.y)));
      if (d > far && this.hit(s.viewport.rayFrom(q.x, q.y)) === g) {
        far = d;
        best = w;
      }
    }
    return { grabAt: best, drawn: [r.drawn()] };
  }

  dispose() {
    this.arrow?.dispose();
    for (const r of this.rings.values()) r.dispose();
    this.rim.geometry.dispose();
    (this.rim.material as THREE.Material).dispose();
    this.group.clear();
  }
}
