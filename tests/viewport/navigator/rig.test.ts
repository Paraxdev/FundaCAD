// The navigator rig driven through a stub canvas, the way a user's pointer
// reaches it: capture, cancel and lost capture end a drag, the left button is
// never taken, and the three.js cameras always carry the pose on screen.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createNavigatorRig } from "../../../src/viewport/navigator/rig";
import { BoxScene, H, UNIT_BOX, W } from "./kit";

type Listener = (e: unknown) => void;

function stubCanvas() {
  const listeners: Record<string, Listener[]> = {};
  const captured = new Set<number>();
  const el = {
    style: {} as Record<string, string>,
    addEventListener: (t: string, f: Listener) => { (listeners[t] ??= []).push(f); },
    removeEventListener: (t: string, f: Listener) => { listeners[t] = (listeners[t] ?? []).filter((g) => g !== f); },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0 }),
    setPointerCapture: (id: number) => { captured.add(id); },
    releasePointerCapture: (id: number) => { captured.delete(id); },
    hasPointerCapture: (id: number) => captured.has(id),
  };
  const fire = (type: string, init: Record<string, unknown>) => {
    const e = { pointerId: 1, pointerType: "mouse", button: -1, buttons: 0, clientX: 0, clientY: 0, shiftKey: false, ctrlKey: false, preventDefault() {}, ...init, type };
    for (const f of listeners[type] ?? []) f(e);
  };
  return { el, fire, captured };
}

function rigWithBox() {
  const c = stubCanvas();
  const rig = createNavigatorRig(c.el as unknown as HTMLElement, W / H);
  const scene = new BoxScene([UNIT_BOX.clone()]);
  rig.setScene(scene);
  rig.setContentBox(scene.box());
  rig.setProjectionMode("persp");
  rig.resize(W, H);
  rig.fit(scene.box(), false);
  rig.navigator.opts.smoothTime = 0;
  rig.update(1 / 60);
  return { rig, ...c };
}

const steady = (rig: ReturnType<typeof rigWithBox>["rig"]) => {
  for (let i = 0; i < 400; i++) rig.update(1 / 60);
};

describe("navigator rig input", () => {
  it("a right drag orbits with the pointer captured, and pointercancel ends it", () => {
    const { rig, fire, captured } = rigWithBox();
    const q0 = rig.navigator.pose.q.clone();
    fire("pointerdown", { button: 2, buttons: 2, clientX: 400, clientY: 300 });
    expect(captured.has(1)).toBe(true);
    fire("pointermove", { buttons: 2, clientX: 440, clientY: 300 });
    rig.update(1 / 60);
    expect(rig.navigator.pose.q.angleTo(q0)).toBeGreaterThan(0.1);
    fire("pointercancel", {});
    expect(rig.navigator.dragging()).toBe(null);
    const q1 = rig.navigator.pose.q.clone();
    fire("pointermove", { buttons: 2, clientX: 500, clientY: 300 });
    steady(rig);
    expect(rig.navigator.pose.q.angleTo(q1)).toBeLessThan(1e-12);
  });

  it("lostpointercapture ends the drag too", () => {
    const { rig, fire } = rigWithBox();
    fire("pointerdown", { button: 1, buttons: 4, clientX: 400, clientY: 300 });
    expect(rig.navigator.dragging()).toBe("pan");
    fire("lostpointercapture", {});
    expect(rig.navigator.dragging()).toBe(null);
  });

  it("a move with the drag's button no longer held ends it", () => {
    const { rig, fire } = rigWithBox();
    fire("pointerdown", { button: 2, buttons: 2, clientX: 400, clientY: 300 });
    fire("pointermove", { buttons: 1, clientX: 410, clientY: 300 });
    expect(rig.navigator.dragging()).toBe(null);
  });

  it("never takes the left button", () => {
    const { rig, fire, captured } = rigWithBox();
    fire("pointerdown", { button: 0, buttons: 1, clientX: 400, clientY: 300 });
    expect(rig.navigator.dragging()).toBe(null);
    expect(captured.size).toBe(0);
  });

  it("Shift+right and a locked orbit pan", () => {
    const { rig, fire } = rigWithBox();
    fire("pointerdown", { button: 2, buttons: 2, shiftKey: true, clientX: 400, clientY: 300 });
    expect(rig.navigator.dragging()).toBe("pan");
    fire("pointerup", {});
    rig.setOrbitLocked(true);
    fire("pointerdown", { button: 2, buttons: 2, clientX: 400, clientY: 300 });
    expect(rig.navigator.dragging()).toBe("pan");
    fire("pointerup", {});
  });

  it("the wheel zooms toward what is under the cursor", () => {
    const { rig } = rigWithBox();
    const s0 = rig.viewScale();
    const e = { clientX: 400, clientY: 300, deltaY: -300, deltaX: 0, deltaMode: 0, ctrlKey: false, preventDefault() {} };
    rig.wheel(e as unknown as WheelEvent);
    steady(rig);
    expect(rig.viewScale()).toBeLessThan(s0);
  });

  it("two touches pinch, and lifting one goes back to a one finger orbit", () => {
    const { rig, fire } = rigWithBox();
    const s0 = rig.viewScale();
    fire("pointerdown", { pointerType: "touch", pointerId: 11, button: 0, buttons: 1, clientX: 350, clientY: 300 });
    expect(rig.navigator.dragging()).toBe("orbit");
    fire("pointerdown", { pointerType: "touch", pointerId: 12, button: 0, buttons: 1, clientX: 450, clientY: 300 });
    expect(rig.navigator.dragging()).toBe("pan");
    fire("pointermove", { pointerType: "touch", pointerId: 11, clientX: 300, clientY: 300 });
    fire("pointermove", { pointerType: "touch", pointerId: 12, clientX: 500, clientY: 300 });
    steady(rig);
    expect(rig.viewScale()).toBeLessThan(s0 * 0.6);
    fire("pointerup", { pointerType: "touch", pointerId: 12 });
    expect(rig.navigator.dragging()).toBe("orbit");
    fire("pointerup", { pointerType: "touch", pointerId: 11 });
    expect(rig.navigator.dragging()).toBe(null);
  });

  it("the three.js camera carries the pose on screen right after a change", () => {
    const { rig } = rigWithBox();
    rig.orbitBy(0.4, 0.2);
    const cam = rig.active as THREE.PerspectiveCamera;
    const eye = rig.getPosition();
    expect(cam.position.distanceTo(eye)).toBeLessThan(1e-9);
    const dir = cam.getWorldDirection(new THREE.Vector3());
    expect(dir.angleTo(rig.viewDirection())).toBeLessThan(1e-9);
    // the picture's centre is the target
    const ndc = rig.getTarget().project(cam);
    expect(Math.hypot(ndc.x, ndc.y)).toBeLessThan(1e-9);
  });

  it("the orthographic camera shows the same scale at the target", () => {
    const { rig } = rigWithBox();
    const t = rig.getTarget();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rig.navigator.pose.q);
    const side = t.clone().addScaledVector(right, 5);
    const a = side.clone().project(rig.active).x;
    rig.setProjectionMode("ortho");
    const b = side.clone().project(rig.active).x;
    expect(Math.abs(a - b)).toBeLessThan(1e-9);
  });

  it("poseVersion moves with the pose and with the viewport size", () => {
    const { rig } = rigWithBox();
    const v0 = rig.poseVersion();
    rig.orbitBy(0.1, 0);
    const v1 = rig.poseVersion();
    expect(v1).toBeGreaterThan(v0);
    rig.resize(W + 10, H);
    expect(rig.poseVersion()).toBeGreaterThan(v1);
  });
});
