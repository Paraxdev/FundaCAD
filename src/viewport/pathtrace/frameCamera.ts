// Which camera a native frame was traced with. The native side draws a frame
// as it is asked for, with the camera it holds then, and answers pt_camera with
// the seq of the last frame it drew before taking the camera. A frame of a
// later seq was traced with that camera or a newer one.

import type * as THREE from "three";

export interface FrameView {
  /** matrixWorld then projectionMatrix. */
  readonly matrices: Float64Array;
  readonly ortho: boolean;
}

interface Sent extends FrameView {
  after: number | null;
}

/** About half a second of cameras at 120 Hz with no frame landing. */
const KEEP = 64;

const isOrtho = (c: THREE.Camera) => (c as THREE.OrthographicCamera).isOrthographicCamera === true;

export class FrameCameras {
  private sent: Sent[] = [];
  private unknown = false;

  /** Records the camera as sent; the returned function takes the reply. */
  send(camera: THREE.Camera): (reply: unknown) => void {
    const matrices = new Float64Array(32);
    matrices.set(camera.matrixWorld.elements, 0);
    matrices.set(camera.projectionMatrix.elements, 16);
    const s: Sent = { matrices, ortho: isOrtho(camera), after: null };
    this.sent.push(s);
    if (this.sent.length > KEEP) this.sent.shift();
    return (reply) => {
      if (typeof reply === "number") s.after = reply;
      else this.unknown = true;
    };
  }

  /** Null when the frame is older than every camera kept, or the native side
   *  answers no seq. A camera whose reply is still to come counts as not taken. */
  of(seq: number): FrameView | null {
    if (this.unknown) return null;
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const s = this.sent[i]!;
      // Seqs are u32 and wrap.
      if (s.after === null || ((seq - s.after) | 0) <= 0) continue;
      if (i > 0) this.sent.splice(0, i);
      return s;
    }
    return null;
  }
}

const standIns = new WeakMap<THREE.Camera, THREE.Camera>();

/** A stand in for `live` placed where the frame was traced from, or `live`
 *  itself when the frame had the other projection. */
export function viewCamera(live: THREE.Camera, view: FrameView): THREE.Camera {
  if (view.ortho !== isOrtho(live)) return live;
  let c = standIns.get(live);
  if (!c) {
    c = new (live.constructor as new () => THREE.Camera)();
    standIns.set(live, c);
  }
  c.copy(live, false);
  c.matrixWorld.fromArray(view.matrices, 0);
  c.matrixWorld.decompose(c.position, c.quaternion, c.scale);
  c.matrixWorldInverse.copy(c.matrixWorld).invert();
  c.projectionMatrix.fromArray(view.matrices, 16);
  c.projectionMatrixInverse.copy(c.projectionMatrix).invert();
  return c;
}
