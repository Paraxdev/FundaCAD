// The camera rig contract, and the factory that picks an implementation.
//
// Mouse map: right = orbit, middle = pan, wheel = zoom, Shift+right = pan.
// Right orbits and middle pans, rather than the other way round, because the
// button you hold for most of a session should be the one your hand rests on.
// Middle-drag then reads as "shove the drawing about", which is what it is: in a
// sketch the pan IS moving the sketch under the cursor, and the orbit is off.

import type * as THREE from "three";
import type CameraControls from "camera-controls";
import { createLegacyRig } from "./legacyRig";

export interface CameraRig {
  controls: CameraControls;
  get active(): THREE.Camera;
  isOrtho(): boolean;
  /** 'auto' = Fusion's "Perspective with Ortho Faces": perspective while orbiting,
   *  orthographic whenever the view axis is world-axis-aligned, so straight-on
   *  views are truly flat (no parallax skew between bodies). */
  projectionMode(): ProjectionMode;
  setProjectionMode(mode: ProjectionMode): void;
  resize(w: number, h: number): void;
  update(dt: number): boolean;
  /** Zoom by a multiplicative factor (>1 = zoom out, <1 = zoom in). Works in BOTH
   *  projections via absolute dolly/zoom, so it's immune to the wheel-action
   *  ambiguity that left perspective unable to zoom in WebKitGTK. When `pivot`
   *  (a world point, usually under the cursor) is given, zooms TOWARD it
   *  (MCAD-style dolly-to-cursor) instead of toward the orbit target. */
  zoomBy(factor: number, pivot?: THREE.Vector3): void;
  /** The model's bounds, which set how far zoomBy may zoom out. */
  setContentBox(box: THREE.Box3): void;
  /** Half the visible view height at the orbit target, in world units, the
   *  natural scale for making input steps (SpaceMouse pan) zoom-proportional
   *  in BOTH projections, like wheel zoom already is. */
  viewScale(): number;
  /** The perspective field of view in degrees, and the setter behind the Render
   *  workspace's lens control. Orthographic views have no fov at all and are
   *  unaffected; the value is kept so switching back to perspective keeps the
   *  lens that was chosen. */
  fov(): number;
  setFov(deg: number): void;
  fit(box: THREE.Box3, enableTransition?: boolean): void;
  /** Back to the view a fresh window opens on: no roll, Z up, looking in from
   *  the front right corner, framed on `box`, or on the origin when there is none. */
  resetView(box: THREE.Box3 | null): void;
  setStandardView(view: StandardView): void;
  /** orient to an arbitrary view direction (eye = target + dir·d), with a chosen
   *  world up. Used by the ViewCube for corners/edges and for redefined sides. */
  setViewDir(dir: THREE.Vector3, up: THREE.Vector3): void;
  /** Roll (bank) the view around the forward / screen-into-monitor axis by
   *  `angle` radians. camera-controls has no native roll, so we rotate the
   *  camera up-vector about the view direction and re-apply it. */
  roll(angle: number): void;
  /** Free-orbit by az/pol radians about the SCREEN axes (SpaceMouse tumble).
   *  Unlike controls.rotate(), which camera-controls clamps just short of the
   *  poles every frame (Spherical.makeSafe), this rotates the orbit up-vector
   *  along with the camera, so vertical orbit passes straight over the top,
   *  3Dconnexion-style free rotation, upside down included. */
  tumble(az: number, pol: number): void;
  /** Lock out mouse orbit (sketch "lock to plane"); right-drag pans instead. */
  setOrbitLocked(locked: boolean): void;
  /** Whether that lock is on.
   *
   *  Readable because the mouse is not the only thing that can orbit. A 3D
   *  mouse has to obey the same lock, and it used to be told separately, which
   *  made sketch mode import the 3D-mouse module to say something the rig
   *  already knew. Two places holding one fact is two places to forget to
   *  update; this is the one that was set first. */
  orbitLocked(): boolean;
  /** Orbit about this world point rather than about the orbit target, until it
   *  is cleared with null. The library still aims the camera at its own target,
   *  so the target is still what sits at the centre of the screen; what this
   *  changes is which point the view TURNS about, and a pivot on the model is
   *  what stops the model swinging out of frame once a pan or an orthographic
   *  zoom-to-cursor has left the target sitting well off it. See
   *  viewport/orbitPivot.ts for why a shift is all it takes. */
  setOrbitPivot(pivot: THREE.Vector3 | null): void;
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
  /** True while a lookAtPlane flight is in the air. Input is off for the
   *  duration, and anything measuring the framing (the sketch lock's baseline)
   *  has to wait for it, mid-flight the camera is nowhere in particular. */
  isFlying(): boolean;
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
