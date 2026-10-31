import { expect, it } from "vitest";
import * as THREE from "three";
import type { CameraRig } from "../../src/viewport/cameras";
import { Viewport } from "../../src/viewport/viewport";

const ROOM = new THREE.Box3(new THREE.Vector3(-100, -100, -100), new THREE.Vector3(100, 100, 100));
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** The rig facing +Y from `eye`, settled, with the projection it chose. */
function lookFrom(rig: CameraRig, eye: THREE.Vector3, target = v(0, 0, 0)): boolean {
  rig.setLookAt(eye, target, false);
  for (let i = 0; i < 30; i++) rig.update(1 / 60);
  return rig.isOrtho();
}

/** Just the sketch entry and exit of a viewport, on a real rig. */
function sketchViewport(rig: CameraRig): Viewport {
  const vp = Object.create(Viewport.prototype) as Viewport;
  const stub = () => {};
  return Object.assign(vp, {
    rig,
    scene: { grid: { group: { visible: true } } },
    sketchOrtho: false,
    requestRender: stub,
    setModelDimmed: stub,
    syncBloomable: stub,
    showSketchFace: stub,
  });
}

function settle(rig: CameraRig) {
  for (let i = 0; i < 120; i++) rig.update(1 / 60);
}

/** The same cases for both camera rigs, `make` giving a fresh one with the room as its content. */
export function autoProjectionCases(make: () => CameraRig) {
  const room = () => {
    const rig = make();
    rig.setContentBox(ROOM.clone());
    rig.setProjectionMode("auto");
    return rig;
  };

  it("stays in perspective on an axis with the eye inside the content box", () => {
    expect(lookFrom(room(), v(0, -50, 0))).toBe(false);
  });

  it("snaps to orthographic on an axis with the eye outside the content box", () => {
    expect(lookFrom(room(), v(0, -1500, 0))).toBe(true);
  });

  it("stays in perspective with the eye on the box wall", () => {
    expect(lookFrom(room(), v(0, -100, 0))).toBe(false);
  });

  it("is perspective off an axis whatever the eye", () => {
    expect(lookFrom(room(), v(1500, -1500, 900))).toBe(false);
  });

  it("an explicit Orthographic gives orthographic with the eye inside", () => {
    const rig = room();
    rig.setProjectionMode("ortho");
    expect(lookFrom(rig, v(0, -50, 0))).toBe(true);
  });

  it("an explicit Perspective stays perspective on an axis outside", () => {
    const rig = room();
    rig.setProjectionMode("persp");
    expect(lookFrom(rig, v(0, -1500, 0))).toBe(false);
  });

  it("with no content box an axis view is orthographic", () => {
    const rig = make();
    rig.setProjectionMode("auto");
    expect(lookFrom(rig, v(0, -50, 0))).toBe(true);
  });

  it("an eye crossing the wall back and forth on an axis does not swap on each wiggle", () => {
    const rig = room();
    expect(lookFrom(rig, v(0, -50, 0))).toBe(false);
    let swaps = 0;
    let was = rig.isOrtho();
    for (let i = 0; i < 40; i++) {
      lookFrom(rig, v(0, i % 2 ? -100.5 : -99.5, 0));
      if (rig.isOrtho() !== was) swaps++;
      was = rig.isOrtho();
    }
    expect(swaps).toBe(0);
  });

  it("zooming in about a point deep in the box stays orthographic", () => {
    const rig = room();
    expect(lookFrom(rig, v(0, -1500, 0))).toBe(true);
    for (let i = 0; i < 8; i++) {
      rig.zoomBy(0.5, v(0, 0, 0));
      for (let t = 0; t < 10; t++) rig.update(1 / 60);
      expect(rig.isOrtho()).toBe(true);
    }
  });

  it("a fit along a long part stays orthographic", () => {
    const beam = new THREE.Box3(v(-10, -250, -10), v(10, 250, 10));
    const rig = make();
    rig.setContentBox(beam);
    rig.setProjectionMode("auto");
    expect(lookFrom(rig, v(0, -1500, 0))).toBe(true);
    rig.fit(beam, false);
    for (let i = 0; i < 30; i++) rig.update(1 / 60);
    expect(rig.isOrtho()).toBe(true);
  });

  it("a rebuild growing the box around the view stays orthographic", () => {
    const rig = room();
    expect(lookFrom(rig, v(0, -1500, 0))).toBe(true);
    rig.setContentBox(new THREE.Box3(v(-2000, -2000, -2000), v(2000, 2000, 2000)));
    for (let i = 0; i < 30; i++) rig.update(1 / 60);
    expect(rig.isOrtho()).toBe(true);
  });

  it("a view set to an eye inside along the same axis goes to perspective and keeps that eye", () => {
    const rig = room();
    expect(lookFrom(rig, v(0, -1500, 0))).toBe(true);
    expect(lookFrom(rig, v(0, -50, 0))).toBe(false);
    expect(rig.active.position.y).toBeCloseTo(-50, 3);
  });

  it("a state taken orthographic comes back orthographic with no swap on the way", () => {
    const beam = new THREE.Box3(v(-10, -250, -10), v(10, 250, 10));
    const rig = make();
    rig.setContentBox(beam);
    rig.setProjectionMode("auto");
    expect(lookFrom(rig, v(0, -1500, 0))).toBe(true);
    rig.fit(beam, false);
    for (let i = 0; i < 30; i++) rig.update(1 / 60);
    const framed = rig.getState();
    rig.setState(framed, false);
    expect(rig.isOrtho()).toBe(true);
    for (let i = 0; i < 30; i++) {
      rig.update(1 / 60);
      expect(rig.isOrtho()).toBe(true);
    }
  });

  it("a state taken in perspective inside the box comes back in perspective at its eye", () => {
    const rig = room();
    expect(lookFrom(rig, v(0, -50, 0))).toBe(false);
    const inside = rig.getState();
    expect(lookFrom(rig, v(0, -1500, 0))).toBe(true);
    rig.setState(inside, false);
    for (let i = 0; i < 30; i++) rig.update(1 / 60);
    expect(rig.isOrtho()).toBe(false);
    expect(rig.active.position.y).toBeCloseTo(-50, 3);
  });

  it("leaving a sketch on a plane deep in the box keeps an orthographic view, with no swap", () => {
    const rig = room();
    expect(lookFrom(rig, v(0, -150, 0))).toBe(true);
    const vp = sketchViewport(rig);
    vp.enterSketchView(v(0, 60, 0), v(0, -1, 0), v(0, 0, 1));
    settle(rig);
    expect([rig.projectionMode(), rig.isOrtho(), ROOM.containsPoint(rig.getPosition())]).toEqual(["ortho", true, true]);
    vp.exitSketchView();
    expect([rig.projectionMode(), rig.isOrtho()]).toEqual(["auto", true]);
    for (let i = 0; i < 120; i++) {
      rig.update(1 / 60);
      expect(rig.isOrtho()).toBe(true);
    }
  });

  it("leaving a sketch entered in perspective inside the box goes back to perspective", () => {
    const rig = room();
    expect(lookFrom(rig, v(0, -50, 0))).toBe(false);
    const vp = sketchViewport(rig);
    vp.enterSketchView(v(0, 60, 0), v(0, -1, 0), v(0, 0, 1));
    settle(rig);
    expect(rig.isOrtho()).toBe(true);
    vp.exitSketchView();
    settle(rig);
    expect([rig.projectionMode(), rig.isOrtho()]).toEqual(["auto", false]);
  });

  it("leaving a sketch on a plane off the axes gives perspective, though it came from orthographic", () => {
    const rig = room();
    expect(lookFrom(rig, v(0, -1500, 0))).toBe(true);
    const vp = sketchViewport(rig);
    vp.enterSketchView(v(0, 0, 0), v(-0.3, -1, 0).normalize(), v(0, 0, 1));
    settle(rig);
    expect(rig.isOrtho()).toBe(true);
    vp.exitSketchView();
    settle(rig);
    expect([rig.projectionMode(), rig.isOrtho()]).toEqual(["auto", false]);
  });

  it("choosing Automatic from Orthographic with the eye inside goes to perspective", () => {
    const rig = room();
    rig.setProjectionMode("ortho");
    expect(lookFrom(rig, v(0, -50, 0))).toBe(true);
    rig.setProjectionMode("auto");
    expect(rig.isOrtho()).toBe(false);
  });

  it("returns to orthographic once the eye is well clear of the box", () => {
    const rig = room();
    expect(lookFrom(rig, v(0, -50, 0))).toBe(false);
    expect(lookFrom(rig, v(0, -300, 0))).toBe(true);
  });
}
