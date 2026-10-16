import * as THREE from "three";

/** The camera the tracer looks through. Never the viewport's own: the tracer
 *  switches the camera it is given to WebGPU clip space and recomputes its
 *  projection, which would break the WebGL draw. `prev` is reused while it is
 *  the same kind of camera. */
export function traceCameraFor(src: THREE.Camera, prev: THREE.Camera | null): THREE.Camera {
  const same = prev && prev.type === src.type;
  const cam = same ? prev : (src.clone() as THREE.Camera);
  if (same) cam.copy(src as never, false);
  cam.matrixWorld.copy(src.matrixWorld);
  cam.matrixAutoUpdate = true;
  return cam;
}
