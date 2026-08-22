// Cameras + navigation. Perspective and Orthographic kept in parallel; toggle
// preserves apparent zoom. camera-controls (yomotsu) with the mouse map the hand
// already knows: right = orbit, middle = pan, wheel = zoom; Shift+right = pan.
//
// Right orbits and middle pans, rather than the other way round, because the
// button you hold for most of a session should be the one your hand rests on.
// Middle-drag then reads as "shove the drawing about", which is what it is: in a
// sketch the pan IS moving the sketch under the cursor, and the orbit is off.

import * as THREE from "three";
import CameraControls from "camera-controls";
import { frameRotation, pivotShift, viewQuaternion } from "./orbitPivot";
import { anchorDolly, orthoZoomStep } from "./zoomAnchor";
import { ease, flightSeconds, worthFlying } from "./viewFlight";
import { MIN_PERSP_DIST, NEAR_AT_REST, perspNear } from "./clipPlanes";

CameraControls.install({ THREE });

const FOV = 45;
/** Half-extent framed when there is nothing to frame (an empty document), in mm.
 *  Roughly a fist-sized part, so the ground grid lands at a legible scale rather
 *  than as one enormous cell or a haze of tiny ones. */
const EMPTY_VIEW_MM = 50;

export interface CameraRig {
  controls: CameraControls;
  get active(): THREE.Camera;
  isOrtho(): boolean;
  /** 'auto' = Fusion's "Perspective with Ortho Faces": perspective while orbiting,
   *  orthographic whenever the view axis is world-axis-aligned — so straight-on
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
  /** Half the visible view height at the orbit target, in world units — the
   *  natural scale for making input steps (SpaceMouse pan) zoom-proportional
   *  in BOTH projections, like wheel zoom already is. */
  viewScale(): number;
  fit(box: THREE.Box3, enableTransition?: boolean): void;
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
   *  along with the camera, so vertical orbit passes straight over the top —
   *  3Dconnexion-style free rotation, upside down included. */
  tumble(az: number, pol: number): void;
  /** Lock out mouse orbit (sketch "lock to plane"); right-drag pans instead. */
  setOrbitLocked(locked: boolean): void;
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
   *  which is where anything that must not happen mid-flight belongs — forcing
   *  the flat projection, baselining the sketch lock. */
  lookAtPlane(
    origin: THREE.Vector3,
    normal: THREE.Vector3,
    up: THREE.Vector3,
    opts?: { animate?: boolean; onArrive?: () => void },
  ): void;
  /** True while a lookAtPlane flight is in the air. Input is off for the
   *  duration, and anything measuring the framing (the sketch lock's baseline)
   *  has to wait for it — mid-flight the camera is nowhere in particular. */
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

export function createCameraRig(
  dom: HTMLElement,
  aspect: number,
): CameraRig {
  const persp = new THREE.PerspectiveCamera(FOV, aspect, NEAR_AT_REST, 10000);
  persp.up.set(0, 0, 1); // Z-up
  persp.position.set(80, -120, 90);

  const frustum = 100;
  const ortho = new THREE.OrthographicCamera(
    (-frustum * aspect) / 2,
    (frustum * aspect) / 2,
    frustum / 2,
    -frustum / 2,
    -10000,
    10000,
  );
  ortho.up.set(0, 0, 1);
  ortho.position.copy(persp.position);

  let usingOrtho = false;
  let active: THREE.Camera = persp;
  let mode: ProjectionMode = "auto";
  let rollAngle = 0; // persistent view bank (radians), re-applied each update()
  let orbitLocked = false; // sketch "lock to plane": disable mouse orbit
  // The lookAtPlane flight, while one is in the air. Driven by update(), not by
  // camera-controls: its own transitions abort on any input, and a sketch view
  // stranded halfway is an oblique plane you then draw on. Ours holds input off
  // and lands on the exact numbers a snap would have written.
  let flight: {
    t: number; // seconds elapsed
    dur: number;
    eye0: THREE.Vector3; tgt0: THREE.Vector3; q0: THREE.Quaternion;
    eye1: THREE.Vector3; tgt1: THREE.Vector3; q1: THREE.Quaternion;
    up1: THREE.Vector3;
    onArrive: (() => void) | null;
  } | null = null;
  // ortho zoom queued this frame but not yet applied by controls.update() —
  // lets same-frame wheel bursts chain correctly (see zoomBy).
  let pendingOrthoZoom: number | null = null;

  const controls = new CameraControls(persp, dom);
  // camera-controls assumes Y-up by default; tell it we orbit around +Z so the
  // ViewCube, standard views, and orbit all behave in CAD (Z-up) space.
  controls.updateCameraUp();

  // mainstream MCAD mouse map. Wheel is handled explicitly by the viewport (rig.zoomBy)
  // rather than camera-controls' built-in action: its perspective DOLLY wheel was
  // unreliable in the WebKitGTK webview, and an absolute dolly/zoom is robust.
  const A = CameraControls.ACTION;
  controls.mouseButtons.left = A.NONE; // left reserved for selection
  controls.mouseButtons.middle = A.TRUCK;
  controls.mouseButtons.right = A.ROTATE;
  controls.mouseButtons.wheel = A.NONE;

  // Shift+right => pan (swap orbit<->truck on the orbit button). Middle is
  // already the pan, so the modifier stays on the button it modifies.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift" && !orbitLocked) controls.mouseButtons.right = A.TRUCK;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift" && !orbitLocked) controls.mouseButtons.right = A.ROTATE;
  });

  controls.dollyToCursor = true;
  controls.setTarget(0, 0, 0, false);

  // Swap the active camera between projections, preserving apparent zoom in BOTH
  // directions. 'auto' mode swaps constantly (every axis-align / orbit-away), so
  // any scale mismatch would pop visibly: persp→ortho bakes the scale into the
  // frustum and clears residual ortho zoom; ortho→persp dollies to the distance
  // that reproduces the ortho apparent height.
  function swapProjection() {
    const from = active;
    const to = usingOrtho ? persp : ortho;
    const dist = controls.distance;
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    if (!usingOrtho) {
      // persp -> ortho: match ortho frustum to the perspective frustum height
      const h = 2 * Math.tan((FOV * Math.PI) / 180 / 2) * dist;
      const aspect2 = (persp.aspect as number) || ortho.right / ortho.top || 1;
      ortho.top = h / 2;
      ortho.bottom = -h / 2;
      ortho.left = (-h * aspect2) / 2;
      ortho.right = (h * aspect2) / 2;
      ortho.updateProjectionMatrix();
      usingOrtho = true;
      active = to;
      controls.camera = to as THREE.PerspectiveCamera & THREE.OrthographicCamera;
      controls.updateCameraUp();
      controls.zoomTo(1, false); // frustum now carries the scale
    } else {
      // ortho -> persp: reproduce the ortho apparent height at the target
      const halfH = (ortho.top - ortho.bottom) / 2 / ortho.zoom;
      const newDist = Math.max(
        MIN_PERSP_DIST,
        halfH / Math.tan((FOV * Math.PI) / 360),
      );
      usingOrtho = false;
      active = to;
      controls.camera = to as THREE.PerspectiveCamera & THREE.OrthographicCamera;
      controls.updateCameraUp();
      controls.dollyTo(newDist, false);
    }
  }

  // 'auto' snaps to ortho when the view axis is within this of a world axis.
  // 0.5°: standard-view transitions converge well inside it, while the smallest
  // deliberate orbit nudge (~0.4°/px) leaves it after a couple of pixels.
  const AXIS_SNAP_COS = Math.cos((0.5 * Math.PI) / 180);
  const tmpTarget = new THREE.Vector3();
  const tmpPos = new THREE.Vector3();
  function viewAxisAligned(): boolean {
    const d = controls.getTarget(tmpTarget).sub(controls.getPosition(tmpPos));
    const len = d.length();
    if (len < 1e-9) return false;
    return Math.max(Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)) / len >= AXIS_SNAP_COS;
  }
  /** In 'auto', keep the actual projection in sync with the view axis. Returns
   *  true when a swap happened (caller should re-render). */
  function applyAutoProjection(): boolean {
    if (mode !== "auto") return false;
    if (viewAxisAligned() === usingOrtho) return false;
    swapProjection();
    return true;
  }

  // The point a mouse orbit turns about, while one is in flight. Null the rest
  // of the time, which is every path that is not a rotation: a pan, a zoom, a
  // ViewCube transition and a SpaceMouse tumble all leave this alone and are
  // unaffected by it.
  let orbitPivot: THREE.Vector3 | null = null;
  // The camera basis and target this correction last saw, so the rotation a drag
  // added between two frames can be measured.
  let lastView: THREE.Quaternion | null = null;
  const lastTarget = new THREE.Vector3();

  /** Turn the rotation the drag has asked for, which camera-controls will apply
   *  about its own target, into the same rotation about `orbitPivot`, by
   *  shifting camera and target together. See viewport/orbitPivot.ts.
   *
   *  Measured on the GOAL, which is what getPosition/getTarget report by
   *  default, not on the rendered camera. A drag writes its rotation straight
   *  into the goal and damping walks the camera there over the following frames,
   *  so sampling the rendered camera measures the damping rather than the drag,
   *  and correcting THAT fights the interpolation. (Sampling it either side of
   *  one controls.update() measures nothing at all: both reads return the same
   *  goal, which is why the first attempt at this computed a zero shift on every
   *  frame of a drag that was plainly rotating.) Shifting the goal leaves the
   *  damping to carry the camera to a destination that is already right. */
  function correctOrbitPivot() {
    const pos = controls.getPosition(new THREE.Vector3());
    const tgt = controls.getTarget(new THREE.Vector3());
    const view = viewQuaternion(pos, tgt, active.up);
    if (!view) return;
    if (orbitPivot && lastView) {
      const d = pivotShift(frameRotation(lastView, view), orbitPivot, lastTarget);
      // A pan or a zoom moves the goal without rotating it, so the shift comes
      // out as zero and this costs one comparison. Only a rotation has anything
      // to correct.
      if (d.lengthSq() > 1e-18) {
        controls.setLookAt(
          pos.x + d.x, pos.y + d.y, pos.z + d.z,
          tgt.x + d.x, tgt.y + d.y, tgt.z + d.z,
          true, // the goal only: damping still carries the rendered camera
        );
        tgt.add(d);
      }
    }
    lastView = view;
    lastTarget.copy(tgt);
  }

  // --- the lookAtPlane flight ------------------------------------------------

  const flightMat = new THREE.Matrix4();
  /** The camera orientation that looks from `eye` at `target` with this up. */
  function orientation(eye: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
    flightMat.lookAt(eye, target, up);
    return new THREE.Quaternion().setFromRotationMatrix(flightMat);
  }

  const flightUp = new THREE.Vector3();
  const flightEye = new THREE.Vector3();
  const flightTgt = new THREE.Vector3();

  /** Put the camera exactly where the flight was going, hand input back, and
   *  tell whoever asked. Called on the last frame AND by anything that has to
   *  end a flight early, so "arrived" and "gave up" leave identical state —
   *  there is no half-way pose the rest of the app can observe. */
  function landFlight() {
    const f = flight;
    if (!f) return;
    flight = null;
    persp.up.copy(f.up1);
    ortho.up.copy(f.up1);
    controls.updateCameraUp();
    controls.setLookAt(f.eye1.x, f.eye1.y, f.eye1.z, f.tgt1.x, f.tgt1.y, f.tgt1.z, false);
    controls.enabled = true;
    f.onArrive?.();
  }

  /** Advance one frame. Returns true when it moved the camera (so the caller
   *  keeps rendering). */
  function stepFlight(dt: number): boolean {
    const f = flight;
    if (!f) return false;
    f.t += dt;
    if (f.t >= f.dur) {
      landFlight();
      return true;
    }
    const s = ease(f.t / f.dur);
    // Orientation by slerp, position by lerp. Interpolating the up-vector
    // directly would collapse on the 180° case — entering a sketch from the far
    // side asks for exactly that — and the two ups are then antiparallel with no
    // shortest arc between them. The quaternion has one.
    const q = f.q0.clone().slerp(f.q1, s);
    flightUp.set(0, 1, 0).applyQuaternion(q).normalize();
    flightEye.copy(f.eye0).lerp(f.eye1, s);
    flightTgt.copy(f.tgt0).lerp(f.tgt1, s);
    persp.up.copy(flightUp);
    ortho.up.copy(flightUp);
    controls.updateCameraUp();
    controls.setLookAt(
      flightEye.x, flightEye.y, flightEye.z,
      flightTgt.x, flightTgt.y, flightTgt.z,
      false,
    );
    return true;
  }

  const rig: CameraRig = {
    controls,
    get active() {
      return active;
    },
    isOrtho() {
      return usingOrtho;
    },
    projectionMode() {
      return mode;
    },
    setProjectionMode(m: ProjectionMode) {
      mode = m;
      const wantOrtho = m === "ortho" || (m === "auto" && viewAxisAligned());
      if (wantOrtho !== usingOrtho) swapProjection();
    },
    resize(w: number, h: number) {
      const aspect2 = w / h;
      persp.aspect = aspect2;
      persp.updateProjectionMatrix();
      const halfH = (ortho.top - ortho.bottom) / 2;
      ortho.left = -halfH * aspect2;
      ortho.right = halfH * aspect2;
      ortho.updateProjectionMatrix();
    },
    update(dt: number) {
      pendingOrthoZoom = null; // camera.zoom is authoritative again after this update
      // The flight writes the goal, then controls.update() below commits it in
      // the same frame. Ahead of correctOrbitPivot because a flight is not a
      // drag and has no pivot to correct — reading one would measure the
      // flight's own rotation and shift the rig by it.
      const flew = stepFlight(dt);
      // BEFORE the update, so this frame damps toward the corrected goal rather
      // than toward one it will have to be pulled back from next frame.
      if (!flew) correctOrbitPivot();
      const moved = controls.update(dt) || flew;
      // The near plane follows the camera in, so a deep zoom cannot push the
      // surface being inspected behind it. See viewport/clipPlanes.ts; at every
      // ordinary distance this writes back the number that was already there.
      const near = perspNear(controls.distance);
      if (persp.near !== near) {
        persp.near = near;
        persp.updateProjectionMatrix();
      }
      const swapped = applyAutoProjection();
      // Apply the persistent roll AFTER camera-controls positions the camera.
      // update() always rewrites the orientation from its own spherical state,
      // so re-banking every frame is idempotent — no drift, no position change,
      // and it never touches camera.up (so it can't fight the sketch-plane up
      // handling or desync camera-controls, which the old updateCameraUp roll did).
      if (rollAngle !== 0) {
        active.rotateZ(rollAngle); // camera local +Z is the view axis → banks in place
        active.updateMatrixWorld();
      }
      return moved || swapped || rollAngle !== 0;
    },
    viewScale() {
      if (usingOrtho) {
        return (ortho.top - ortho.bottom) / 2 / ortho.zoom;
      }
      return controls.distance * Math.tan((FOV * Math.PI) / 360);
    },
    zoomBy(factor: number, pivot?: THREE.Vector3) {
      // A wheel event during a flight would write a goal the flight overwrites
      // on the next frame — a visible stutter for no effect. Input is off for a
      // few hundred milliseconds; the wheel is part of the input.
      if (flight) return;
      const f = Math.max(0.1, Math.min(10, factor));
      if (usingOrtho) {
        // ortho.zoom only commits at the next controls.update(); fast wheels
        // deliver several events per frame, so chain off the PENDING zoom or
        // each same-frame step recomputes k against a stale value (over-trucks
        // the cursor tracking and drops all but one step of zoom).
        const curZoom = pendingOrthoZoom ?? ortho.zoom;
        // The zoom and the truck come from ONE call, against the controls' own
        // limits — see orthoZoomStep for what happened when they came from two.
        const { zoom: newZoom, truck: k } = orthoZoomStep(
          curZoom, f, controls.minZoom, controls.maxZoom,
        );
        pendingOrthoZoom = newZoom;
        if (pivot) {
          // keep the cursor point fixed on screen: TRUCK camera and target together
          // toward it as the frustum shrinks/grows (k = 1 − oldZoom/newZoom).
          // Moving only the target re-aims the camera at it — a rotation that
          // progressively tilted the locked sketch view ~3°/click. Translating
          // both endpoints by the same delta keeps the view direction bit-exact.
          const target = controls.getTarget(new THREE.Vector3());
          const pos = controls.getPosition(new THREE.Vector3());
          const dx = (pivot.x - target.x) * k;
          const dy = (pivot.y - target.y) * k;
          const dz = (pivot.z - target.z) * k;
          controls.setLookAt(
            pos.x + dx,
            pos.y + dy,
            pos.z + dz,
            target.x + dx,
            target.y + dy,
            target.z + dz,
            false,
          );
        }
        controls.zoomTo(newZoom, false);
      } else if (pivot) {
        // Dolly TOWARD THE CURSOR, by scaling camera and target about the cursor
        // point together. See zoomAnchor.ts for why that pins the point under the
        // cursor, and why projecting it onto the view axis first — which is what
        // this did until the point under the cursor was measured over a long
        // zoom — loses it within a handful of notches.
        const next = anchorDolly(
          controls.getPosition(new THREE.Vector3()),
          controls.getTarget(new THREE.Vector3()),
          pivot,
          f,
          MIN_PERSP_DIST,
        );
        if (!next) return; // already as close as we allow
        const { position: nc, target: nt } = next;
        controls.setLookAt(nc.x, nc.y, nc.z, nt.x, nt.y, nt.z, false);
      } else {
        // no pivot (programmatic): plain dolly toward the orbit target
        controls.dollyTo(Math.max(MIN_PERSP_DIST, controls.distance * f), false);
      }
    },
    fit(box: THREE.Box3, enableTransition = true) {
      // Manual fit that PRESERVES the current view direction. (camera-controls'
      // fitToBox resets the orbit to an axis view under a Z-up camera.)
      const center = box.getCenter(new THREE.Vector3());
      const sphere = box.getBoundingSphere(new THREE.Sphere(center.clone()));
      // An EMPTY document has an empty box, and three.js answers that with
      // Sphere.makeEmpty() — radius -1, not 0. Multiplied through, `dist` came
      // out NEGATIVE and the camera was placed behind its own target, looking
      // away from the scene: an empty viewport with no grid and no way to tell
      // why. It never showed while startup always loaded an example part with a
      // real box. Fall back to a human-scale view of the origin instead.
      let r = sphere.radius * 1.15; // padding
      if (!Number.isFinite(r) || r <= 0) {
        r = EMPTY_VIEW_MM;
        center.set(0, 0, 0);
      }
      const dir = controls
        .getPosition(new THREE.Vector3())
        .sub(controls.getTarget(new THREE.Vector3()))
        .normalize();
      if (dir.lengthSq() < 1e-6) dir.set(1, -1, 0.8).normalize();

      let dist: number;
      if (usingOrtho) {
        // frame the sphere by setting the ortho zoom via frustum height
        const aspect2 = (ortho.right - ortho.left) / (ortho.top - ortho.bottom);
        const halfH = Math.max(r, r / Math.max(aspect2, 1e-3));
        ortho.top = halfH;
        ortho.bottom = -halfH;
        ortho.left = -halfH * aspect2;
        ortho.right = halfH * aspect2;
        ortho.updateProjectionMatrix();
        dist = Math.max(controls.distance, r * 2);
      } else {
        dist = r / Math.sin((FOV * Math.PI) / 180 / 2);
      }
      controls.setTarget(center.x, center.y, center.z, enableTransition);
      controls.setPosition(
        center.x + dir.x * dist,
        center.y + dir.y * dist,
        center.z + dir.z * dist,
        enableTransition,
      );
    },
    setStandardView(view: StandardView) {
      rollAngle = 0;
      // a free tumble may have left the orbit up-vector anywhere; a standard
      // view means "square me to the world" — restore Z-up first
      persp.up.set(0, 0, 1);
      ortho.up.set(0, 0, 1);
      controls.updateCameraUp();
      const d = Math.max(controls.distance, 50);
      const dirs: Record<StandardView, [number, number, number]> = {
        front: [0, -1, 0],
        back: [0, 1, 0],
        left: [-1, 0, 0],
        right: [1, 0, 0],
        top: [0, 0, 1],
        bottom: [0, 0, -1],
        iso: [1, -1, 0.8],
      };
      const [x, y, z] = dirs[view];
      const t = controls.getTarget(new THREE.Vector3());
      const n = new THREE.Vector3(x, y, z).normalize().multiplyScalar(d);
      controls.setPosition(t.x + n.x, t.y + n.y, t.z + n.z, true);
    },
    setViewDir(dir, up) {
      rollAngle = 0;
      // orient to a free direction with a chosen up. The camera keeps using +Z
      // up afterward for orbiting unless `up` differs; for the cube's axis views
      // (up = +Z) this matches setStandardView, and for top/bottom (up = ±Y) it
      // squares correctly. We set the camera up so the framing is upright.
      const d = Math.max(controls.distance, 50);
      const n = dir.clone().normalize();
      const u = up.clone().normalize();
      persp.up.copy(u);
      ortho.up.copy(u);
      controls.updateCameraUp();
      const t = controls.getTarget(new THREE.Vector3());
      controls.setLookAt(
        t.x + n.x * d,
        t.y + n.y * d,
        t.z + n.z * d,
        t.x,
        t.y,
        t.z,
        true,
      );
    },
    lookAtPlane(origin, normal, up, opts) {
      rollAngle = 0;
      // A flight already in the air is abandoned where it stands, not landed:
      // the destination it was carrying has just been superseded, and putting
      // the camera there first would show a pose nobody asked for.
      flight = null;
      controls.enabled = true;
      // Square the camera to a sketch plane: up = sketch +Y, look down -normal.
      const dist = Math.max(controls.distance, 120);
      const eye = origin.clone().addScaledVector(normal, dist);
      const from = controls.getPosition(new THREE.Vector3());
      const fromTgt = controls.getTarget(new THREE.Vector3());
      const q0 = orientation(from, fromTgt, active.up);
      const q1 = orientation(eye, origin, up);
      // The turn as an angle, so the duration can be proportional to it.
      const turn = 2 * Math.acos(Math.min(1, Math.abs(q0.dot(q1))));
      const reach = from.distanceTo(fromTgt);
      const zoomRatio = reach > 1e-6 ? dist / reach : 1;
      const land = () => {
        persp.up.copy(up);
        ortho.up.copy(up);
        controls.updateCameraUp();
        controls.setLookAt(eye.x, eye.y, eye.z, origin.x, origin.y, origin.z, false);
        opts?.onArrive?.();
      };
      if (!opts?.animate || !worthFlying(turn, zoomRatio)) {
        land();
        return;
      }
      // Input off for the duration. This is the whole reason the flight can be
      // trusted where camera-controls' own transition could not: nothing can
      // interrupt it, so it lands on the numbers `land()` would have written
      // and the sketch plane is square to the pixel.
      controls.enabled = false;
      flight = {
        t: 0,
        dur: flightSeconds(turn, zoomRatio),
        eye0: from, tgt0: fromTgt, q0,
        eye1: eye, tgt1: origin.clone(), q1,
        up1: up.clone(),
        onArrive: opts?.onArrive ?? null,
      };
    },
    isFlying() {
      return flight !== null;
    },
    restoreUp() {
      rollAngle = 0;
      flight = null;
      controls.enabled = true;
      // Re-seat the orbit AFTER changing up: updateCameraUp() only rebuilds the
      // internal up-basis — the stored spherical state still encodes the OLD
      // basis, so without setPosition the same numbers decode to a different
      // world position on the next tick (exiting a top-plane sketch snapped the
      // camera to a side-on view — the flat sketch "disappeared" edge-on).
      // Same getPosition→updateCameraUp→setPosition pattern as the library's
      // own applyCameraUp().
      const pos = controls.getPosition(new THREE.Vector3());
      // Z-up is the model default, but exiting a sketch on a Z-normal plane (XY,
      // or a plane parallel to it) leaves the camera looking straight DOWN -Z —
      // where world +Z is PARALLEL to the view axis. That is a degenerate orbit
      // basis: the pole sits on the view direction, so orbit gimbal-locks and
      // "moves a little, then jams" (SpaceMouse and mouse alike). Fall back to
      // Y-up for a near-vertical view so the basis stays well-conditioned.
      const fwd = controls.getTarget(new THREE.Vector3()).sub(pos).normalize();
      const up = Math.abs(fwd.z) > 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      persp.up.copy(up);
      ortho.up.copy(up);
      controls.updateCameraUp();
      controls.setPosition(pos.x, pos.y, pos.z, false);
    },
    roll(angle) {
      // accumulate; the bank is re-applied every frame in update(). Cheap and
      // safe — no camera-controls state is touched here.
      rollAngle += angle;
    },
    tumble(az, pol) {
      // Rotate the camera OFFSET and the orbit UP-VECTOR together about the
      // screen axes (yaw about visual up, pitch about visual right), then
      // re-seat camera-controls in the rotated up-space. Because offset and up
      // rotate by the same quaternion, the polar angle camera-controls sees
      // NEVER changes — the pole travels with the camera, so its per-frame
      // (0, π) clamp (Spherical.makeSafe) has nothing to bite. Axis signs
      // match controls.rotate(): +az orbits CCW seen from above, +pol tips
      // the camera downward.
      const target = controls.getTarget(new THREE.Vector3());
      const offset = controls.getPosition(new THREE.Vector3()).sub(target);
      active.updateMatrixWorld();
      // visual axes from the rendered orientation (roll bank included)
      const right = new THREE.Vector3().setFromMatrixColumn(active.matrixWorld, 0);
      const vup = new THREE.Vector3().setFromMatrixColumn(active.matrixWorld, 1);
      const q = new THREE.Quaternion()
        .setFromAxisAngle(vup.normalize(), az)
        .multiply(new THREE.Quaternion().setFromAxisAngle(right.normalize(), pol));
      offset.applyQuaternion(q);
      const u = persp.up.clone().applyQuaternion(q).normalize();
      persp.up.copy(u);
      ortho.up.copy(u);
      controls.updateCameraUp();
      controls.setLookAt(
        target.x + offset.x,
        target.y + offset.y,
        target.z + offset.z,
        target.x,
        target.y,
        target.z,
        false,
      );
    },
    setOrbitLocked(locked) {
      orbitLocked = locked;
      // right-drag pans while locked (no orbit); restore orbit on unlock. Middle
      // is the pan either way, so a locked sketch simply has two pan buttons
      // rather than one button that changed meaning.
      controls.mouseButtons.right = locked ? A.TRUCK : A.ROTATE;
    },
    setOrbitPivot(p) {
      orbitPivot = p ? p.clone() : null;
      // Drop the remembered basis with it: the gap between one gesture and the
      // next holds every camera move that is not this drag (a ViewCube flight, a
      // standard view, a fit), and reading a rotation across that gap would
      // shift the rig by the whole of it on the drag's first frame.
      lastView = null;
    },
  };

  return rig;
}
