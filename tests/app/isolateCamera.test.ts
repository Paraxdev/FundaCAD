import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { installIsolateCamera, sameCameraState } from "../../src/app/isolateCamera";
import type { CameraState } from "../../src/viewport/cameras";

const pose = (x: number, scale: number): CameraState => ({
  target: [x, 0, 0], quaternion: [0, 0, 0, 1], scale, fov: 45, mode: "auto",
});

function rig() {
  const s = {
    state: pose(0, 400),
    animatedTo: [] as CameraState[],
    getState: () => ({ ...s.state, target: [...s.state.target] as CameraState["target"] }),
    setState: (st: CameraState, animate?: boolean) => {
      s.state = st;
      if (animate) s.animatedTo.push(st);
    },
    fit: (box: THREE.Box3) => {
      const c = box.getCenter(new THREE.Vector3());
      s.state = pose(c.x, box.getSize(new THREE.Vector3()).length());
    },
  };
  return s;
}

function harness() {
  const vis = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  const store = {
    isolateActive: false,
    buildState: { result: { bodies: [{ id: "big" }, { id: "small" }] } },
    isBodyVisible: (id: string) => vis.get(id) ?? true,
    onBuild: (fn: () => void) => { listeners.add(fn); fn(); return () => listeners.delete(fn); },
  };
  const r = rig();
  const boxes: Record<string, THREE.Box3> = {
    big: new THREE.Box3(new THREE.Vector3(-240, -230, -20), new THREE.Vector3(240, 230, 20)),
    small: new THREE.Box3(new THREE.Vector3(-121, -121, 80), new THREE.Vector3(-79, -79, 120)),
  };
  const view = {
    rig: r,
    requestRender: () => {},
    bodiesBox: (ids: readonly string[]) => {
      const b = new THREE.Box3();
      for (const id of ids) if (boxes[id]) b.union(boxes[id]!);
      return b.isEmpty() ? null : b;
    },
  };
  const queue: (() => void)[] = [];
  installIsolateCamera(store, view, (fn) => queue.push(fn));
  const emit = () => { for (const fn of listeners) fn(); };
  const settle = () => { while (queue.length) queue.shift()!(); };
  const isolate = (keep: string[]) => {
    for (const id of ["big", "small"]) vis.set(id, keep.includes(id));
    store.isolateActive = false;
    emit();
    store.isolateActive = true;
    emit();
    settle();
  };
  const showAll = () => {
    vis.clear();
    store.isolateActive = false;
    emit();
    settle();
  };
  return { r, isolate, showAll };
}

describe("isolate and the camera", () => {
  it("frames what it keeps, animated", () => {
    const { r, isolate } = harness();
    isolate(["small"]);
    expect(r.state.target[0]).toBeCloseTo(-100);
    expect(r.animatedTo).toHaveLength(1);
  });

  it("puts the earlier view back when it ends and the camera was left alone", () => {
    const { r, isolate, showAll } = harness();
    const start = r.getState();
    isolate(["small"]);
    showAll();
    expect(sameCameraState(r.state, start)).toBe(true);
  });

  it("keeps where the user took the camera meanwhile", () => {
    const { r, isolate, showAll } = harness();
    isolate(["small"]);
    r.state = pose(-90, 30);
    showAll();
    expect(r.state.target[0]).toBe(-90);
  });

  it("does not treat the visibility write inside an isolate as the isolate ending", () => {
    const { r, isolate } = harness();
    isolate(["small"]);
    isolate(["big"]);
    // One saved view, the one from before the first isolate, and two framings.
    expect(r.animatedTo).toHaveLength(2);
    expect(r.state.target[0]).toBeCloseTo(0);
  });
});
