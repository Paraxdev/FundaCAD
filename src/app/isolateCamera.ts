// Isolate frames what it keeps, and ending it puts the view back.
//
// Isolating a small or off centre body left the camera framed on everything
// that had just been hidden, so the part it was meant to show was a speck, or
// off screen, and it read as the model vanishing.

import type * as THREE from "three";
import type { CameraState } from "../viewport/cameras";

export interface IsolateCameraStore {
  readonly isolateActive: boolean;
  readonly buildState: { result: { bodies?: { id: string }[] } | null };
  isBodyVisible(id: string): boolean;
  onBuild(fn: () => void): () => void;
}

export interface IsolateCameraView {
  bodiesBox(ids: readonly string[]): THREE.Box3 | null;
  readonly rig: {
    getState(): CameraState;
    setState(state: CameraState, animate?: boolean): void;
    fit(box: THREE.Box3, opts?: boolean | { animate?: boolean }): void;
  };
  requestRender(): void;
}

/** Same pose, to within what a float round trip leaves. */
export function sameCameraState(a: CameraState, b: CameraState): boolean {
  const near = (x: number, y: number, tol: number) => Math.abs(x - y) <= tol;
  const len = Math.max(1e-6, a.scale) * 1e-4;
  return a.mode === b.mode
    && near(a.scale, b.scale, len)
    && near(a.fov, b.fov, 1e-6)
    && a.target.every((v, i) => near(v, b.target[i]!, len))
    && Math.abs(a.quaternion.reduce((s, v, i) => s + v * b.quaternion[i]!, 0)) >= 1 - 1e-6;
}

export function installIsolateCamera(
  store: IsolateCameraStore,
  view: IsolateCameraView,
  defer: (fn: () => void) => void = queueMicrotask,
): () => void {
  let lastKey: string | null = null;
  let before: CameraState | null = null;
  let framed: CameraState | null = null;
  let pending = false;

  // Settled a tick later: isolating emits twice, the visibility write and then
  // the isolate flag, and the first on its own looks like isolate ending.
  const check = () => {
    pending = false;
    const kept = store.isolateActive
      ? (store.buildState.result?.bodies ?? []).map((b) => b.id).filter((id) => store.isBodyVisible(id))
      : null;
    const key = kept ? kept.join("\n") : null;
    if (key === lastKey) return;
    lastKey = key;
    if (kept) {
      const box = view.bodiesBox(kept);
      if (!box) return;
      const from = view.rig.getState();
      before ??= from;
      // Fitted once instantly to learn where the animation ends, which is what
      // tells a camera the user has since moved from one still where this left it.
      view.rig.fit(box, false);
      framed = view.rig.getState();
      view.rig.setState(from, false);
      view.rig.setState(framed, true);
      view.requestRender();
      return;
    }
    if (before && framed && sameCameraState(view.rig.getState(), framed)) {
      view.rig.setState(before, true);
      view.requestRender();
    }
    before = null;
    framed = null;
  };

  return store.onBuild(() => {
    if (pending) return;
    pending = true;
    defer(check);
  });
}
