import * as THREE from "three";
import { PhysicalCamera } from "three-gpu-pathtracer/src/objects/PhysicalCamera.js";

/** A thin lens, in world millimetres. */
export interface TraceLens {
  focusDistance: number;
  apertureRadius: number;
}

/** The lens that blurs like the Realtime bokeh pass, or null where that pass is
 *  off. The pass offsets its taps up to 0.4 of `dofblur` (a fraction of the
 *  width), with dofblur = depth offset * 0.006 / fStop, capped at 0.012 * blur,
 *  so a few millimetres from the focus its blur is flat. A thin lens of radius R
 *  blurs a point at depth d over R |d - f| / d on the focal plane, which grows
 *  with depth instead. R gives the pass's cap a quarter of the focus distance in
 *  front of the focus, or the pass's slope at the focus, whichever is smaller. */
export function lensFor(camera: THREE.Camera, focusDistance: number, fStop: number, focusBlur: number): TraceLens | null {
  const cam = camera as THREE.PerspectiveCamera;
  if (!cam.isPerspectiveCamera || focusBlur <= 0 || !(focusDistance > 0) || !(fStop > 0)) return null;
  const halfWidth = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect / cam.zoom;
  const slope = 0.4 * (0.006 / fStop) * 2 * focusDistance * focusDistance * halfWidth;
  const cap = 3 * 0.4 * 0.012 * focusBlur * 2 * focusDistance * halfWidth;
  return { focusDistance, apertureRadius: Math.min(slope, cap) };
}

/** The camera the tracer looks through. Never the viewport's own: the tracer
 *  switches the camera it is given to WebGPU clip space and recomputes its
 *  projection, which would break the WebGL draw. `prev` is reused while it is
 *  the same kind of camera. */
export function traceCameraFor(src: THREE.Camera, prev: THREE.Camera | null, lens: TraceLens | null = null): THREE.Camera {
  const physical = !!lens && (src as THREE.PerspectiveCamera).isPerspectiveCamera === true;
  const same = prev && prev.type === src.type && prev instanceof PhysicalCamera === physical;
  let cam: THREE.Camera;
  if (same) cam = prev.copy(src as never, false);
  else cam = physical ? new PhysicalCamera().copy(src as THREE.PerspectiveCamera, false) : (src.clone() as THREE.Camera);
  if (physical) {
    const p = cam as PhysicalCamera;
    p.apertureBlades = 0;
    p.apertureRotation = 0;
    p.anamorphicRatio = 1;
    p.focusDistance = lens!.focusDistance;
    // The tracer's shader reads bokehSize as millimetres of a metre scene and
    // scales it by 1e-3; this scene is in millimetres.
    p.bokehSize = lens!.apertureRadius * 2 * 1000;
  }
  cam.matrixWorld.copy(src.matrixWorld);
  cam.matrixAutoUpdate = true;
  return cam;
}
