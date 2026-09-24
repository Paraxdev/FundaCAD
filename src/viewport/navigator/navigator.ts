// The navigator: one pose, eased gestures applied as exact transforms, flights,
// limits and the checks that keep the target on what is being looked at.
// No DOM and no three.js cameras here; rig.ts binds it to both.
//
// Pixel coordinates are the viewport's own, origin top left, y down.

import * as THREE from "three";
import type { NavScene, ProjectionMode } from "../cameras";
import {
  centreDepth, orbitPivot, zoomAnchor, type AnchorContext,
} from "./anchor";
import { OrbitChannel, PanChannel, ZoomChannel } from "./channels";
import { makeFlight, stepFlight, type Flight } from "./flight";
import {
  clampScale, contentLimits, defaultLimits, elevRange, minScaleOf, type Limits,
} from "./limits";
import { decompose, turntableQuat, wrapAngle } from "./math";
import {
  rotateAbout, rotateWorldAbout, reseat, scaleAbout, truck, turntableAbout,
} from "./motions";
import {
  clonePose, copyPose, depthOf, distanceOf, eyeOf, forwardOf, halfTan, makePose,
  poseFinite, project, rightOf, setOrientation, setTurntable, upOf, worldPerPixel,
  type Frame, type Pose,
} from "./pose";

/** One wheel pixel of zoom, as a log factor: 100px (a notch) is 1.17x. */
export const WHEEL_LOG_PER_PX = Math.log(1.0016);
/** A trackpad pinch arrives as ctrl+wheel with small deltas. */
export const PINCH_LOG_PER_PX = 0.01;
/** Mouse orbit speed, radians per viewport height. */
export const ORBIT_PER_HEIGHT = 2 * Math.PI;
/** An orbit press that stays within this many pixels is a right click (the
 *  viewport's menu threshold), so it turns nothing. */
export const CLICK_SLOP_PX = 5;
/** Drag distance over which a banked view (3D mouse roll) comes back level. */
export const RELEVEL_PX = 80;
/** 'auto' projection is orthographic within this of a world axis. */
const AXIS_SNAP_COS = Math.cos((0.5 * Math.PI) / 180);
/** The model ball the target is kept in, in bounding radii. */
export const CONTAIN_FACTOR = 1.5;
/** Seconds of drag velocity an inertial orbit carries on after release. */
const INERTIA_S = 0.3;

export type NavigatorEvent = "inputstart" | "inputend" | "change" | "rest";

export interface NavigatorOptions {
  /** Smooth time of the eased gestures, seconds. 0 is raw. */
  smoothTime: number;
  inertia: boolean;
}

type Gesture = { kind: "orbit"; x: number; y: number; vx: number; vy: number; started: boolean } | { kind: "pan" } | null;

export class Navigator {
  readonly pose: Pose = makePose();
  frame: Frame = { width: 800, height: 600 };
  opts: NavigatorOptions = { smoothTime: 0.125, inertia: false };

  private mode: ProjectionMode = "auto";
  private userLimits: Partial<Limits> = {};
  limits: Limits = defaultLimits();
  private box: THREE.Box3 | null = null;
  private plane: THREE.Plane | null = null;
  private scene: NavScene | null = null;
  private locked = false;
  private orbitPoint: THREE.Vector3 | null = null;

  private zooms: ZoomChannel[] = [];
  private orbit: OrbitChannel | null = null;
  private pan: PanChannel | null = null;
  private flight: Flight | null = null;
  private gesture: Gesture = null;
  private wheelAt: { x: number; y: number; log: number } | null = null;
  private pinchZoom: ZoomChannel | null = null;
  /** The pan channel is a two-finger scroll's rather than a drag's. */
  private scrolling = false;
  /** A gesture moved the view and its re-seat has not run yet. */
  private unsettled = false;
  private good: Pose = makePose();
  private version = 0;
  private stamp = makePose();
  private listeners: Record<NavigatorEvent, Set<() => void>> = {
    inputstart: new Set(), inputend: new Set(), change: new Set(), rest: new Set(),
  };

  constructor() {
    setTurntable(this.pose, 0, Math.PI / 2);
    copyPose(this.good, this.pose);
    copyPose(this.stamp, this.pose);
  }

  // --- events -----------------------------------------------------------------

  on(ev: NavigatorEvent, fn: () => void): () => void {
    this.listeners[ev].add(fn);
    return () => this.listeners[ev].delete(fn);
  }
  private emit(ev: NavigatorEvent) {
    for (const fn of this.listeners[ev]) fn();
  }

  poseVersion(): number {
    return this.version;
  }
  /** Bump the version for a change that moves pixels without moving the pose. */
  touch() {
    this.version++;
    this.emit("change");
  }

  // --- configuration ------------------------------------------------------------

  setFrame(width: number, height: number) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (w === this.frame.width && h === this.frame.height) return;
    this.frame = { width: w, height: h };
    this.recomputeLimits();
    this.touch();
  }

  setScene(scene: NavScene | null) {
    this.scene = scene;
  }

  setContentBox(box: THREE.Box3 | null) {
    this.box = box && !box.isEmpty() ? box.clone() : null;
    this.recomputeLimits();
  }

  contentBox(): THREE.Box3 | null {
    return this.box;
  }

  setAnchorPlane(plane: THREE.Plane | null) {
    this.plane = plane ? plane.clone() : null;
  }

  setLimits(l: Partial<Limits>) {
    this.userLimits = { ...this.userLimits, ...l };
    this.recomputeLimits();
  }

  private recomputeLimits() {
    let base = defaultLimits();
    if (this.box) {
      const r = this.box.getBoundingSphere(new THREE.Sphere()).radius;
      const m = Math.max(
        Math.abs(this.box.min.x), Math.abs(this.box.min.y), Math.abs(this.box.min.z),
        Math.abs(this.box.max.x), Math.abs(this.box.max.y), Math.abs(this.box.max.z),
      );
      base = contentLimits(base, r, m, this.pose.fov, this.frame.height);
    }
    this.limits = { ...base, ...this.userLimits };
  }

  setOrbitLocked(on: boolean) {
    this.locked = on;
    if (on && this.gesture?.kind === "orbit") this.endGesture();
  }
  orbitLocked(): boolean {
    return this.locked;
  }

  projectionMode(): ProjectionMode {
    return this.mode;
  }
  setProjectionMode(m: ProjectionMode) {
    this.mode = m;
    const want = m === "ortho" || (m === "auto" && this.axisAligned());
    if (want !== this.pose.ortho) {
      this.pose.ortho = want;
      this.moved();
    }
  }

  private ctx(): AnchorContext {
    return { scene: this.scene, plane: this.plane, box: this.box, frame: this.frame };
  }

  // --- reading ------------------------------------------------------------------

  eye(out = new THREE.Vector3()): THREE.Vector3 {
    return eyeOf(this.pose, out);
  }
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return forwardOf(this.pose, out);
  }
  isFlying(): boolean {
    return this.flight !== null;
  }
  isBusy(): boolean {
    return this.flight !== null || this.gesture !== null || this.zooms.length > 0
      || this.orbit !== null || this.pan !== null || this.wheelAt !== null;
  }
  pixelOf(point: THREE.Vector3): { x: number; y: number; depth: number } {
    return project(this.pose, this.frame, point);
  }
  pivotAt(x: number, y: number): THREE.Vector3 {
    return this.orbitPoint?.clone() ?? orbitPivot(this.pose, this.ctx(), x, y);
  }

  // --- gestures -------------------------------------------------------------------

  /** A soft flight gives way to input at the frame on screen; a hard one does
   *  not take input at all. False when the input has to be ignored. */
  private takeInput(): boolean {
    if (this.flight?.hard) return false;
    this.flight = null;
    // An orbit still easing (or coasting) after its release stops where it is
    // shown, or it would carry a new gesture's anchor away from the cursor.
    if (!this.gesture) this.orbit?.freeze();
    return true;
  }

  beginOrbit(x: number, y: number) {
    if (this.locked) {
      this.beginPan(x, y);
      return;
    }
    if (!this.takeInput()) return;
    this.endGesture(true);
    const pivot = this.pivotAt(x, y);
    const t = this.pose.level ? { yaw: this.pose.yaw, elev: this.pose.elev, roll: 0 } : decompose(this.pose.q);
    this.orbit = new OrbitChannel(pivot, t.yaw, t.elev, t.roll);
    this.gesture = { kind: "orbit", x, y, vx: 0, vy: 0, started: false };
    this.emit("inputstart");
  }

  beginPan(x: number, y: number) {
    if (!this.takeInput()) return;
    this.endGesture(true);
    const grab = zoomAnchor(this.pose, this.ctx(), x, y).point;
    this.pan = new PanChannel(grab, x, y);
    this.scrolling = false;
    this.gesture = { kind: "pan" };
    this.emit("inputstart");
  }

  /** The pointer moved during a gesture; `dt` (seconds since the last move)
   *  only feeds the inertia estimate. */
  dragTo(x: number, y: number, dt = 1 / 60) {
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "pan") {
      if (this.pan) {
        this.pan.cx = x;
        this.pan.cy = y;
      }
      return;
    }
    const o = this.orbit;
    if (!o) return;
    const dx = x - g.x;
    const dy = y - g.y;
    if (!g.started && Math.hypot(dx, dy) <= CLICK_SLOP_PX) return;
    g.started = true;
    g.x = x;
    g.y = y;
    if (dx === 0 && dy === 0) return;
    // Auto leaves orthographic when the turn starts (not at the press, which
    // may only be a right click for the menu), and never mid-drag.
    if (this.mode === "auto" && this.pose.ortho) {
      this.pose.ortho = false;
      this.moved();
    }
    this.orbitGoal(o, dx, dy);
    if (dt > 0) {
      const k = Math.min(1, dt / 0.05);
      g.vx += (dx / dt - g.vx) * k;
      g.vy += (dy / dt - g.vy) * k;
    }
  }

  private orbitGoal(o: OrbitChannel, dx: number, dy: number) {
    const h = Math.max(1, this.frame.height);
    const [lo, hi] = elevRange(this.limits);
    o.goalYaw -= (ORBIT_PER_HEIGHT * dx) / h;
    o.goalElev = Math.min(hi, Math.max(lo, o.goalElev - (ORBIT_PER_HEIGHT * dy) / h));
    o.travelled += Math.hypot(dx, dy);
    o.goalRoll = o.roll0 * Math.max(0, 1 - o.travelled / RELEVEL_PX);
  }

  /** Release, cancel or lost capture: the gesture ends, its easing finishes. */
  endGesture(silent = false) {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    this.pinchZoom = null;
    if (g.kind === "orbit" && this.orbit && this.opts.inertia) {
      this.orbitGoal(this.orbit, g.vx * INERTIA_S, g.vy * INERTIA_S);
    }
    if (!silent) this.emit("inputend");
  }

  dragging(): "orbit" | "pan" | null {
    return this.gesture?.kind ?? null;
  }

  /** Wheel input, gathered and applied once per frame. `pinch` is a trackpad
   *  pinch (ctrl+wheel). */
  wheel(x: number, y: number, deltaPx: number, pinch = false) {
    if (!this.takeInput()) return;
    const d = Math.max(-240, Math.min(240, deltaPx));
    const log = d * (pinch ? PINCH_LOG_PER_PX : WHEEL_LOG_PER_PX);
    if (this.wheelAt && Math.abs(this.wheelAt.x - x) < 0.5 && Math.abs(this.wheelAt.y - y) < 0.5) {
      this.wheelAt.log += log;
    } else {
      if (this.wheelAt) this.flushWheel();
      this.wheelAt = { x, y, log };
    }
    this.emit("inputstart");
  }

  /** Two-finger pinch: zoom about the anchor under the midpoint and pan it
   *  along with the fingers. */
  beginPinch(mx: number, my: number) {
    if (!this.takeInput()) return;
    this.endGesture(true);
    const a = zoomAnchor(this.pose, this.ctx(), mx, my);
    if (a.kind !== "target" && this.canReseat(a.depth)) reseat(this.pose, a.depth);
    this.pan = new PanChannel(a.point, mx, my);
    this.scrolling = false;
    this.pinchZoom = new ZoomChannel(a.point, mx, my);
    this.zooms.push(this.pinchZoom);
    this.gesture = { kind: "pan" };
    this.emit("inputstart");
  }

  pinchTo(mx: number, my: number, logFactor: number) {
    if (this.gesture?.kind !== "pan" || !this.pan) return;
    this.pan.cx = mx;
    this.pan.cy = my;
    this.pinchZoom?.add(logFactor);
  }

  /** Two-finger scroll as a pan: the content follows the fingers 1:1. */
  scrollPan(x: number, y: number, dx: number, dy: number) {
    if (!this.takeInput() || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (!this.pan || !this.scrolling || this.gesture) {
      this.endGesture(true);
      const grab = zoomAnchor(this.pose, this.ctx(), x, y).point;
      this.pan = new PanChannel(grab, x, y);
      this.scrolling = true;
    }
    this.pan.cx -= dx;
    this.pan.cy -= dy;
    this.emit("inputstart");
  }

  private flushWheel() {
    const w = this.wheelAt;
    this.wheelAt = null;
    if (!w || w.log === 0) return;
    // The last channel's anchor is still the right one while it sits under the
    // cursor, which it does for as long as only that channel moved the view.
    let ch = this.zooms[this.zooms.length - 1];
    const at = ch ? project(this.pose, this.frame, ch.anchor) : null;
    if (!ch || !at || Math.abs(at.x - w.x) >= 0.5 || Math.abs(at.y - w.y) >= 0.5) {
      const a = zoomAnchor(this.pose, this.ctx(), w.x, w.y);
      if (a.kind !== "target" && this.canReseat(a.depth)) reseat(this.pose, a.depth);
      ch = new ZoomChannel(a.point, w.x, w.y);
      this.zooms.push(ch);
    }
    ch.add(w.log);
    this.unsettled = true;
  }

  // --- the frame ------------------------------------------------------------------

  /** Advance one frame of `dt` seconds. True when the pose changed. */
  update(dt: number): boolean {
    const before = this.version;
    const tau = this.opts.smoothTime;
    if (this.flight) {
      const done = stepFlight(this.flight, dt, this.pose);
      // The ends are inside the limits; a lens change between them can dip a
      // hair outside, since the floor on the scale moves with the lens.
      this.pose.scale = clampScale(this.limits, this.pose.fov, this.pose.scale);
      this.moved();
      if (done) {
        const f = this.flight;
        this.flight = null;
        f.onArrive?.();
      }
    } else {
      this.flushWheel();
      this.stepZooms(tau, dt);
      this.stepOrbit(tau, dt);
      this.stepPan(tau, dt);
    }
    if (!this.isBusy() && this.unsettled) {
      this.unsettled = false;
      this.reseatAndContain();
      this.emit("rest");
    }
    if (this.mode === "auto" && this.gesture?.kind !== "orbit" && !this.orbit) {
      const want = this.axisAligned();
      if (want !== this.pose.ortho) {
        this.pose.ortho = want;
        this.moved();
      }
    }
    this.sanitize();
    return this.version !== before;
  }

  private stepZooms(tau: number, dt: number) {
    if (!this.zooms.length) return;
    for (const ch of this.zooms) {
      const want = ch.step(tau, dt);
      if (want === 0) continue;
      const got = this.limitedLog(ch.anchor, want);
      if (got !== 0) {
        scaleAbout(this.pose, ch.anchor, Math.exp(got));
        this.moved();
      }
      if (got !== want) ch.stopAt(got, want);
    }
    // A pinch's channel stays while the fingers are down, even at rest.
    this.zooms = this.zooms.filter((c) => c === this.pinchZoom || !c.settled());
    this.unsettled = true;
  }

  /** How much of a log zoom about A the limits allow. */
  private limitedLog(a: THREE.Vector3, log: number): number {
    const p = this.pose;
    let lo = Math.log(minScaleOf(this.limits, p.fov) / p.scale);
    const hi = Math.log(this.limits.maxScale / p.scale);
    if (!p.ortho) {
      const depth = depthOf(p, a);
      if (depth > 0) lo = Math.max(lo, Math.log(this.limits.minDistance / depth));
    }
    // A view already past a limit holds still rather than jumping back.
    if (log < 0) return Math.min(0, Math.max(log, lo));
    return Math.max(0, Math.min(log, hi));
  }

  private stepOrbit(tau: number, dt: number) {
    const o = this.orbit;
    if (!o) return;
    const a = o.step(tau, dt);
    const roll = Math.abs(a.roll) < 1e-12 ? 0 : a.roll;
    // A button held still (a right click on its way to the menu) turns nothing.
    const same = a.yaw === o.shown.yaw && a.elev === o.shown.elev && roll === o.shown.roll;
    if (!same) {
      turntableAbout(this.pose, o.pivot, a.yaw, a.elev, roll);
      o.shown = { yaw: a.yaw, elev: a.elev, roll };
      this.moved();
      this.unsettled = true;
    }
    if (!this.gesture && o.settled()) this.orbit = null;
  }

  private stepPan(tau: number, dt: number) {
    const c = this.pan;
    if (!c) return;
    const g = project(this.pose, this.frame, c.grab);
    const [mx, my] = c.step(g.x, g.y, tau, dt);
    if (mx !== 0 || my !== 0) {
      const wpp = worldPerPixel(this.pose, this.frame, g.depth);
      truck(this.pose, -mx * wpp, my * wpp);
      this.moved();
    }
    this.unsettled = true;
    // Kept while a zoom is still easing, whose last step can nudge the grab.
    if (this.gesture?.kind !== "pan" && this.zooms.length === 0) {
      const now = project(this.pose, this.frame, c.grab);
      if (c.settled(now.x, now.y)) {
        this.pan = null;
        this.scrolling = false;
      }
    }
  }

  /** After a gesture: put the target on the surface at the centre of the screen,
   *  or, over empty space, inside the model's ball. Only along the view axis,
   *  so nothing on screen moves. */
  reseatAndContain() {
    const p = this.pose;
    const d = centreDepth(p, this.ctx());
    if (d !== null && this.canReseat(d)) {
      reseat(p, d);
      this.moved();
      return;
    }
    this.contain();
  }

  private contain() {
    const p = this.pose;
    if (!this.box) return;
    const sphere = this.box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 1e-9) * CONTAIN_FACTOR;
    if (p.target.distanceTo(sphere.center) <= r) return;
    const dc = depthOf(p, sphere.center);
    const eye = eyeOf(p, new THREE.Vector3());
    const fwd = forwardOf(p, new THREE.Vector3());
    const off = eye.clone().addScaledVector(fwd, dc).distanceTo(sphere.center);
    const cur = distanceOf(p);
    let depth = dc;
    if (off < r) {
      const h = Math.sqrt(r * r - off * off);
      depth = Math.abs(dc - h - cur) < Math.abs(dc + h - cur) ? dc - h : dc + h;
    }
    if (!p.ortho) {
      depth = Math.max(depth, this.limits.minDistance);
      if (depth * halfTan(p.fov) > this.limits.maxScale) return;
    }
    reseat(p, depth);
    this.moved();
  }

  /** Whether the target may move to this depth without the scale there
   *  leaving the limits (orthographic keeps its scale, so always). */
  private canReseat(depth: number): boolean {
    const p = this.pose;
    if (p.ortho) return Number.isFinite(depth);
    return depth >= this.limits.minDistance && depth * halfTan(p.fov) <= this.limits.maxScale;
  }

  private axisAligned(): boolean {
    const f = forwardOf(this.pose, new THREE.Vector3());
    return Math.max(Math.abs(f.x), Math.abs(f.y), Math.abs(f.z)) >= AXIS_SNAP_COS;
  }

  private moved() {
    this.version++;
    this.emit("change");
  }

  /** Finite and inside the limits, or back to the last pose that was. */
  private sanitize() {
    const p = this.pose;
    if (!poseFinite(p)) {
      const ortho = p.ortho;
      copyPose(p, this.good);
      p.ortho = ortho;
      this.zooms = [];
      this.orbit = null;
      this.pan = null;
      this.flight = null;
      this.moved();
      return;
    }
    if (p.level) {
      const [lo, hi] = elevRange(this.limits);
      if (p.elev < lo || p.elev > hi) setTurntable(p, p.yaw, Math.min(hi, Math.max(lo, p.elev)));
    }
    copyPose(this.good, p);
  }

  // --- programmatic motions -----------------------------------------------------

  private stopAll() {
    this.zooms = [];
    this.orbit = null;
    this.pan = null;
    this.wheelAt = null;
    this.endGesture(true);
  }

  /** Go to a pose, flying when asked. Input cancels a soft flight where it
   *  stands; a hard one lands first. */
  flyTo(to: Pose, opts: { animate?: boolean | undefined; hard?: boolean; onArrive?: (() => void) | undefined; duration?: number } = {}) {
    this.stopAll();
    this.flight = null;
    const target = clonePose(to);
    target.ortho = this.pose.ortho;
    target.scale = clampScale(this.limits, target.fov, target.scale);
    const f = makeFlight(this.pose, target, opts.hard ?? false, opts.onArrive ?? null, opts.duration);
    if (!opts.animate || !(f.dur > 0)) {
      stepFlight(f, f.dur, this.pose);
      this.moved();
      opts.onArrive?.();
      return;
    }
    this.flight = f;
  }

  /** Where the view is going: a flight's destination while one is in the air,
   *  so a programmatic change asked for mid-flight builds on it rather than on
   *  the frame it happened to be at. */
  private destination(): Pose {
    return clonePose(this.flight?.to ?? this.pose);
  }

  /** The destination with an orientation, keeping T and s unless given. */
  poseWith(q: THREE.Quaternion, target?: THREE.Vector3, scale?: number): Pose {
    const p = this.destination();
    setOrientation(p, q);
    if (target) p.target.copy(target);
    if (scale !== undefined) p.scale = scale;
    return p;
  }

  setLookAt(eye: THREE.Vector3, target: THREE.Vector3, animate = false) {
    const d = eye.distanceTo(target);
    if (!(d > 0) || !Number.isFinite(d)) return;
    const q = lookQuat(eye, target);
    this.flyTo(this.poseWith(q, target, d * halfTan(this.pose.fov)), { animate });
  }

  rotateTo(azimuth: number, polar: number, animate = false) {
    const [lo, hi] = elevRange(this.limits);
    const p = this.destination();
    setTurntable(p, azimuth, Math.min(hi, Math.max(lo, polar)));
    this.flyTo(p, { animate });
  }

  moveTo(point: THREE.Vector3, animate = false) {
    const p = this.destination();
    p.target.copy(point);
    this.flyTo(p, { animate });
  }

  setViewScale(scale: number, animate = false) {
    if (!(scale > 0) || !Number.isFinite(scale)) return;
    const p = this.destination();
    p.scale = clampScale(this.limits, p.fov, scale);
    this.flyTo(p, { animate });
  }

  /** Immediate zoom (3D mouse, programmatic) about `pivot`, or about the
   *  surface at the centre of the screen, which it can never pass. */
  zoomBy(factor: number, pivot?: THREE.Vector3) {
    if (!(factor > 0) || !Number.isFinite(factor) || !this.takeInput()) return;
    let a = pivot;
    if (a && !this.pose.ortho && !(depthOf(this.pose, a) > this.limits.minDistance)) a = undefined;
    if (!a) {
      this.reseatAndContain();
      a = this.pose.target.clone();
    }
    const got = this.limitedLog(a, Math.log(factor));
    if (got === 0) return;
    scaleAbout(this.pose, a, Math.exp(got));
    this.moved();
  }

  /** Immediate pan by half view heights at the (re-seated) target depth. */
  panScreen(dx: number, dy: number) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !this.takeInput()) return;
    this.reseatAndContain();
    truck(this.pose, dx * this.pose.scale, -dy * this.pose.scale);
    this.moved();
  }

  /** Immediate turntable orbit about the orbit point, else the target. */
  orbitBy(az: number, pol: number) {
    if (!this.takeInput()) return;
    const pivot = this.orbitPoint ?? this.pose.target.clone();
    const t = this.pose.level ? { yaw: this.pose.yaw, elev: this.pose.elev, roll: 0 } : decompose(this.pose.q);
    const [lo, hi] = elevRange(this.limits);
    turntableAbout(this.pose, pivot, t.yaw + az, Math.min(hi, Math.max(lo, t.elev + pol)), t.roll);
    this.moved();
  }

  /** Free rotation about the screen axes, over the poles (3D mouse). One of the
   *  two ways the horizon can leave level. */
  tumble(az: number, pol: number) {
    if (!this.takeInput() || (az === 0 && pol === 0)) return;
    this.orbit = null;
    this.reseatAndContain();
    const up = upOf(this.pose, new THREE.Vector3());
    const right = rightOf(this.pose, new THREE.Vector3());
    const r = new THREE.Quaternion().setFromAxisAngle(up, az)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, pol));
    rotateWorldAbout(this.pose, this.orbitPoint ?? this.pose.target.clone(), r);
    this.moved();
  }

  /** Bank about the view axis (3D mouse), the other way off level. */
  roll(angle: number) {
    if (!this.takeInput() || angle === 0 || !Number.isFinite(angle)) return;
    this.orbit = null;
    const q = this.pose.q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle));
    rotateAbout(this.pose, this.pose.target.clone(), q);
    setOrientation(this.pose, this.pose.q);
    this.moved();
  }

  /** Back to level, softly: the same view direction with Z up. */
  restoreUp(animate = true) {
    // A flight still in the air (sketch entry) is abandoned where it stands:
    // landing it would run its arrival for a sketch that has already closed.
    this.flight = null;
    if (this.pose.level) return;
    const t = decompose(this.pose.q);
    const p = clonePose(this.pose);
    setTurntable(p, t.yaw, t.elev);
    this.flyTo(p, { animate });
  }

  setOrbitPoint(point: THREE.Vector3 | null) {
    this.orbitPoint = point ? point.clone() : null;
    if (!point) return;
    const d = depthOf(this.pose, point);
    if (this.canReseat(d)) {
      reseat(this.pose, d);
      this.moved();
    }
  }

  /** Frame a sphere, keeping the view direction. */
  fitSphere(center: THREE.Vector3, radius: number, opts: { animate?: boolean; padding?: number } = {}) {
    let c = center;
    let r = radius * (opts.padding ?? 1.15);
    if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(c.x + c.y + c.z)) {
      r = EMPTY_VIEW_MM;
      c = new THREE.Vector3();
    }
    const p = this.destination();
    p.target.copy(c);
    p.scale = frameScale(p, this.frame, r);
    this.flyTo(p, { animate: opts.animate });
  }

  /** The view a fresh window opens on. */
  resetView(center: THREE.Vector3 | null, radius: number, animate: boolean) {
    const p = clonePose(this.pose);
    const home = HOME_EYE.clone().normalize();
    const q = lookQuat(home, new THREE.Vector3());
    setOrientation(p, q);
    if (center) {
      p.target.copy(center);
      p.scale = frameScale(p, this.frame, radius * 1.15);
    } else {
      p.target.set(0, 0, 0);
      p.scale = HOME_EYE.length() * halfTan(p.fov);
    }
    this.flyTo(p, { animate });
  }

  /** Turn to an orientation about the point of the view axis nearest the
   *  content's centre (the target when there is none), keeping the scale there. */
  turnTo(q: THREE.Quaternion, animate = true) {
    const p = this.destination();
    let pivot = p.target.clone();
    if (this.box) {
      const c = this.box.getCenter(new THREE.Vector3());
      const d = depthOf(p, c);
      if (p.ortho || d > this.limits.minDistance) {
        pivot = eyeOf(p, new THREE.Vector3()).addScaledVector(forwardOf(p, new THREE.Vector3()), d);
      }
    }
    const scaleThere = p.ortho ? p.scale : depthOf(p, pivot) * halfTan(p.fov);
    this.flyTo(this.poseWith(q, pivot, scaleThere), { animate });
  }

  lookAtPlane(origin: THREE.Vector3, normal: THREE.Vector3, up: THREE.Vector3, animate: boolean, onArrive?: () => void) {
    const n = normal.clone().normalize();
    const q = lookQuatUp(n, up);
    this.flyTo(this.poseWith(q, origin, this.pose.scale), { animate, hard: true, onArrive });
  }

  /** Change the lens. keepScale holds the size of what is at the target (a
   *  dolly zoom); otherwise the eye holds still. */
  setFov(deg: number, keepScale: boolean, animate: boolean) {
    const want = Math.min(90, Math.max(10, deg));
    if (!Number.isFinite(want) || want === this.pose.fov) return;
    const p = clonePose(this.pose);
    p.fov = want;
    if (!keepScale && !p.ortho) p.scale = this.pose.scale * (halfTan(want) / halfTan(this.pose.fov));
    this.flyTo(p, { animate });
  }

}

/** Where a fresh window's camera sits, relative to what it looks at. */
export const HOME_EYE = new THREE.Vector3(80, -120, 90);
/** Half-extent framed when there is nothing to frame (an empty document), in mm. */
export const EMPTY_VIEW_MM = 50;

/** The half height at the target that fits a ball of radius r in both
 *  directions of the frame. */
export function frameScale(p: Pose, v: Frame, r: number): number {
  const aspect = v.width > 0 && v.height > 0 ? v.width / v.height : 1;
  if (p.ortho) return Math.max(r, r / Math.max(aspect, 1e-3));
  const tv = halfTan(p.fov);
  const halfV = Math.atan(tv);
  const halfH = Math.atan(tv * aspect);
  const d = r / Math.sin(Math.min(halfV, halfH));
  return d * tv;
}

const lookM = new THREE.Matrix4();
/** The orientation looking from eye to target with Z up, or Y up when the view
 *  is vertical. */
export function lookQuat(eye: THREE.Vector3, target: THREE.Vector3): THREE.Quaternion {
  const dir = target.clone().sub(eye).normalize();
  const up = Math.abs(dir.z) > 1 - 1e-12 ? new THREE.Vector3(0, dir.z < 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1);
  lookM.lookAt(eye, target, up);
  return new THREE.Quaternion().setFromRotationMatrix(lookM);
}

/** The orientation looking down -n with screen up as near `up` as it can be. */
export function lookQuatUp(n: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  const u = up.clone().addScaledVector(n, -up.dot(n));
  if (u.lengthSq() < 1e-18) return lookQuat(n, new THREE.Vector3());
  lookM.lookAt(n, new THREE.Vector3(), u.normalize());
  return new THREE.Quaternion().setFromRotationMatrix(lookM);
}

export { turntableQuat, wrapAngle };
