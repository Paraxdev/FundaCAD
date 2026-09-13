// One owner for everything a session sets up: listeners, three.js resources,
// timers, subscriptions. Each is registered as it is created and released in
// reverse order by one dispose(), so a teardown cannot forget the one that was
// added last.

import type * as THREE from "three";

type Cleanup = () => void;

export class Disposer {
  private cleanups: Cleanup[] = [];
  private disposed = false;

  /** Register a cleanup. Returns it, so a caller can also run it early. */
  add(fn: Cleanup): Cleanup {
    if (this.disposed) {
      fn();
      return fn;
    }
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      fn();
    };
    this.cleanups.push(once);
    return once;
  }

  listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: boolean | AddEventListenerOptions): Cleanup;
  listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: boolean | AddEventListenerOptions): Cleanup;
  listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: boolean | AddEventListenerOptions): Cleanup;
  listen(target: EventTarget, type: string, fn: (e: never) => void, opts?: boolean | AddEventListenerOptions): Cleanup {
    const handler = fn as unknown as EventListener;
    target.addEventListener(type, handler, opts);
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    return this.add(() => target.removeEventListener(type, handler, { capture }));
  }

  timeout(fn: () => void, ms: number): Cleanup {
    const id = setTimeout(fn, ms);
    return this.add(() => clearTimeout(id));
  }

  frame(fn: FrameRequestCallback): Cleanup {
    const id = requestAnimationFrame(fn);
    return this.add(() => cancelAnimationFrame(id));
  }

  /** Remove `object` from its parent and free what it owns. */
  object(object: THREE.Object3D, opts: { materials?: boolean } = {}): Cleanup {
    return this.add(() => disposeObject3D(object, opts));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const list = this.cleanups;
    this.cleanups = [];
    for (let i = list.length - 1; i >= 0; i--) {
      try {
        list[i]!();
      } catch (e) {
        console.error("cleanup failed", e);
      }
    }
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

/** Take an object out of the scene and free every geometry under it, and its
 *  materials too unless they are shared (the default keeps them). */
export function disposeObject3D(object: THREE.Object3D, opts: { materials?: boolean } = {}) {
  object.removeFromParent();
  object.traverse((o) => {
    const mesh = o as Partial<THREE.Mesh>;
    mesh.geometry?.dispose();
    if (!opts.materials || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) m.dispose();
  });
}
