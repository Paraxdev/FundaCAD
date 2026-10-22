import * as THREE from "three";
import { PhysicalCamera } from "three-gpu-pathtracer/src/objects/PhysicalCamera.js";

/** A thin lens, in world millimetres. */
export interface TraceLens {
  focusDistance: number;
  apertureRadius: number;
}

/** The Realtime bokeh blur goes flat a few mm off focus, a thin lens blur grows with depth, so R matches the
 *  pass's cap a quarter of the focus distance in front, or its slope at the focus, whichever is smaller. */
export function lensFor(
  camera: THREE.Camera,
  focusDistance: number,
  fStop: number,
  focusBlur: number,
): TraceLens | null {
  const cam = camera as THREE.PerspectiveCamera;
  if (!cam.isPerspectiveCamera || focusBlur <= 0 || !(focusDistance > 0) || !(fStop > 0)) return null;
  const halfWidth = (Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect) / cam.zoom;
  const slope = 0.4 * (0.006 / fStop) * 2 * focusDistance * focusDistance * halfWidth;
  const cap = 3 * 0.4 * 0.012 * focusBlur * 2 * focusDistance * halfWidth;
  return { focusDistance, apertureRadius: Math.min(slope, cap) };
}

/** Never the viewport's own camera: the tracer switches it to WebGPU clip space and recomputes its
 *  projection, which would break the WebGL draw. `prev` is reused while it is the same kind. */
export function traceCameraFor(
  src: THREE.Camera,
  prev: THREE.Camera | null,
  lens: TraceLens | null = null,
): THREE.Camera {
  const physical = !!lens && (src as THREE.PerspectiveCamera).isPerspectiveCamera === true;
  const same = prev && prev.type === src.type && prev instanceof PhysicalCamera === physical;
  let cam: THREE.Camera;
  if (same) cam = prev.copy(src as never, false);
  else
    cam = physical ? new PhysicalCamera().copy(src as THREE.PerspectiveCamera, false) : (src.clone() as THREE.Camera);
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
