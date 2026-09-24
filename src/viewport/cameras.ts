// The camera rig contract, and the factory that picks an implementation.
//
// Mouse map: right = orbit, middle = pan, wheel = zoom, Shift+right = pan.
// Right orbits and middle pans, rather than the other way round, because the
// button you hold for most of a session should be the one your hand rests on.
// Middle-drag then reads as "shove the drawing about", which is what it is: in a
// sketch the pan IS moving the sketch under the cursor, and the orbit is off.

import type * as THREE from "three";
import { createLegacyRig } from "./legacyRig";

/** What the rig may ask of the scene it looks at. The viewport provides it; the
 *  headless tests provide analytic stand-ins. */
export interface NavScene {
  /** Distance along a world ray (unit `dir`) to the first visible model surface,
   *  or null for a miss. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3): number | null;
  /** Height of the ground plane while it is drawn, else null. */
  groundZ(): number | null;
}

/** A saved view, plain data so it survives JSON. */
export interface CameraState {
  target: [number, number, number];
  quaternion: [number, number, number, number];
  /** Half the visible view height at the target, in world units. */
  scale: number;
  fov: number;
  mode: ProjectionMode;
}

export interface FitOptions {
  animate?: boolean;
  /** Multiple of the bounding radius that is framed, 1.15 by default. */
  padding?: number;
}

export interface NavLimits {
  /** Closest the eye may come to what it zooms toward, in world units. */
  minDistance: number;
  /** Largest half view height, in world units. */
  maxScale: number;
  /** Pitch range in degrees, -90 looking straight down, +90 straight up. */
  minPitch: number;
  maxPitch: number;
}

export type NavEvent = "inputstart" | "inputend" | "change" | "rest";

export interface CameraRig {
  get active(): THREE.Camera;
  isOrtho(): boolean;
  /** 'auto' = perspective while orbiting, orthographic whenever the view axis
   *  is world-axis-aligned, so straight-on views are truly flat (no parallax
   *  skew between bodies). */
  projectionMode(): ProjectionMode;
  setProjectionMode(mode: ProjectionMode): void;
  resize(w: number, h: number): void;
  /** Advance one frame. True when the pose on screen changed. */
  update(dt: number): boolean;

  // --- reading the pose ------------------------------------------------------
  /** The point at the centre of the screen that the view turns and scales about. */
  getTarget(out?: THREE.Vector3): THREE.Vector3;
  getPosition(out?: THREE.Vector3): THREE.Vector3;
  /** Unit vector the camera looks along. */
  viewDirection(out?: THREE.Vector3): THREE.Vector3;
  /** Bumped whenever anything that moves a projected pixel changes (pose,
   *  lens, viewport size), so overlays can reproject on change alone. */
  poseVersion(): number;
  /** Half the visible view height at the target, in world units. */
  viewScale(): number;
  getState(): CameraState;
  setState(state: CameraState, animate?: boolean): void;

  // --- the scene -------------------------------------------------------------
  setScene(scene: NavScene | null): void;
  /** The model's bounds, which set the zoom-out limit and the clip planes. */
  setContentBox(box: THREE.Box3): void;
  /** A plane the zoom may anchor on over empty space (the open sketch's). */
  setAnchorPlane(plane: THREE.Plane | null): void;
  setLimits(limits: Partial<NavLimits>): void;

  // --- input -----------------------------------------------------------------
  on(event: NavEvent, fn: () => void): () => void;
  /** Shorthand for on("inputstart"): the user has taken the camera. */
  onInputStart(fn: () => void): () => void;
  /** A wheel event caught somewhere else (an overlay that takes pointer
   *  events), handed over so the view still zooms under it. */
  wheel(e: WheelEvent): void;
  /** The point a right drag starting at these client coords would orbit about. */
  pivotAt(clientX: number, clientY: number): THREE.Vector3 | null;
  /** Lock out mouse orbit (sketch "lock to plane"); right-drag pans instead. */
  setOrbitLocked(locked: boolean): void;
  /** Whether that lock is on. The 3D mouse obeys it too, so it reads it here. */
  orbitLocked(): boolean;

  // --- motions ---------------------------------------------------------------
  /** Zoom by a multiplicative factor (>1 out, <1 in) toward `pivot`, else
   *  toward the surface at the centre of the screen. */
  zoomBy(factor: number, pivot?: THREE.Vector3): void;
  /** Move the view by (dx, dy) half view heights: +dx moves the camera right,
   *  +dy moves it down, the same sense as a truck. */
  panScreen(dx: number, dy: number): void;
  /** Turntable orbit about the target by az (about world Z) and pol (tilt)
   *  radians. Positive pol tips the camera up over the top. */
  orbitBy(az: number, pol: number): void;
  /** Free rotation about the screen axes (3D mouse tumble), over the poles. */
  tumble(az: number, pol: number): void;
  /** Bank the view about the view axis by `angle` radians. */
  roll(angle: number): void;
  /** Turntable angles, radians: azimuth 0 looks from -Y (front), polar 0 from +Z. */
  rotateTo(azimuth: number, polar: number, animate?: boolean): void;
  /** Move the target to a point, keeping the orientation and scale. */
  moveTo(point: THREE.Vector3, animate?: boolean): void;
  setLookAt(eye: THREE.Vector3, target: THREE.Vector3, animate?: boolean): void;
  /** The pose `t` of the way from one look-at to another, set at once. */
  lerpLookAt(
    eyeA: THREE.Vector3, targetA: THREE.Vector3,
    eyeB: THREE.Vector3, targetB: THREE.Vector3,
    t: number, animate?: boolean,
  ): void;
  /** Set the half view height at the target (the zoom), in world units. */
  setViewScale(scale: number, animate?: boolean): void;
  /** Turn and zoom about this point from now on, until null. The screen does
   *  not move when it is set. */
  setOrbitPoint(point: THREE.Vector3 | null): void;
  /** The perspective field of view in degrees. Orthographic views are
   *  unaffected; the value is kept for the next perspective view. */
  fov(): number;
  /** `keepScale` keeps what sits at the target the same size on screen while
   *  the lens changes (a dolly zoom); without it the eye stays put. */
  setFov(deg: number, opts?: { keepScale?: boolean; animate?: boolean }): void;
  fit(box: THREE.Box3, opts?: boolean | FitOptions): void;
  fitSphere(sphere: THREE.Sphere, opts?: boolean | FitOptions): void;
  /** Back to the view a fresh window opens on: no roll, Z up, looking in from
   *  the front right corner, framed on `box`, or on the origin when there is none. */
  resetView(box: THREE.Box3 | null): void;
  setStandardView(view: StandardView): void;
  /** Orient to an arbitrary view direction (eye = target + dir·d) with a chosen
   *  world up. Used by the ViewCube for corners, edges and redefined sides. */
  setViewDir(dir: THREE.Vector3, up: THREE.Vector3): void;
  /** Square the camera to a plane: up = `up`, looking down -`normal`.
   *
   *  `opts.animate` flies there over a few hundred milliseconds instead of
   *  cutting; `opts.onArrive` runs when it lands (immediately when it snapped),
   *  which is where anything that must not happen mid-flight belongs, forcing
   *  the flat projection, baselining the sketch lock. */
  lookAtPlane(
    origin: THREE.Vector3,
    normal: THREE.Vector3,
    up: THREE.Vector3,
    opts?: { animate?: boolean; onArrive?: () => void },
  ): void;
  /** True while a flight is in the air. Anything measuring the framing (the
   *  sketch lock's baseline) has to wait for it. */
  isFlying(): boolean;
  /** Level the horizon again (Z up) after a sketch or a 3D mouse roll. */
  restoreUp(): void;
}

export type StandardView =
  | "front"
  | "back"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "iso";

export type ProjectionMode = "persp" | "ortho" | "auto";

export function createCameraRig(dom: HTMLElement, aspect: number): CameraRig {
  return createLegacyRig(dom, aspect);
}
