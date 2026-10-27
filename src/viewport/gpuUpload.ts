import type * as THREE from "three";

type Uploadable = THREE.BufferAttribute | THREE.InterleavedBuffer;

// three uploads only the queued ranges when there are any, so a span queued after a whole rewrite but before the frame
// would leave the rest of the rewrite off the GPU. A buffer stays whole until the renderer reports its upload.
const whole = new WeakSet<Uploadable>();

/** Send the whole buffer on the next frame, whatever spans are queued after this. */
export function uploadWhole(attr: Uploadable): void {
  attr.clearUpdateRanges();
  attr.needsUpdate = true;
  if (whole.has(attr)) return;
  whole.add(attr);
  attr.onUpload(() => whole.delete(attr));
}

/** Send `count` items from `start` on the next frame, or the whole buffer when one is already due. */
export function uploadSpan(attr: Uploadable, start: number, count: number): void {
  if (!whole.has(attr)) attr.addUpdateRange(start, count);
  attr.needsUpdate = true;
}
