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

  const UP = v(0, 0, 1);
  const inside = (rig: CameraRig) => lookFrom(rig, v(30, -50, 20));

  it("a named view on an axis with the eye inside the content box is orthographic", () => {
    for (const [view, along] of [
      ["front", v(0, -1, 0)],
      ["top", v(0, 0, 1)],
      ["right", v(1, 0, 0)],
    ] as const) {
      const rig = room();
      expect(inside(rig)).toBe(false);
      rig.setStandardView(view);
      settle(rig);
      expect([view, rig.isOrtho()]).toEqual([view, true]);
      expect(rig.getPosition(v(0, 0, 0)).dot(along)).toBeGreaterThan(0);
    }
  });

  it("a view cube click on an axis with the eye inside is orthographic, a sketch exit direction is not", () => {
    const clicked = room();
    inside(clicked);
    clicked.setViewDir(v(0, -1, 0), UP, true);
    settle(clicked);
    expect(clicked.isOrtho()).toBe(true);
    const plain = room();
    inside(plain);
    plain.setViewDir(v(0, -1, 0), UP);
    settle(plain);
    expect(plain.isOrtho()).toBe(false);
  });

  it("an edge, corner or isometric view stays perspective inside", () => {
    for (const dir of [v(1, -1, 0), v(1, -1, 1), v(0, -1, 1)]) {
      const rig = room();
      inside(rig);
      rig.setViewDir(dir, UP, true);
      settle(rig);
      expect(rig.isOrtho()).toBe(false);
    }
    const rig = room();
    inside(rig);
    rig.setStandardView("iso");
    settle(rig);
    expect(rig.isOrtho()).toBe(false);
  });

  it("a named view from outside the content box is orthographic as before", () => {
    const rig = room();
    expect(lookFrom(rig, v(900, -1500, 700))).toBe(false);
    rig.setStandardView("front");
    settle(rig);
    expect(rig.isOrtho()).toBe(true);
  });

  it("an explicit projection mode holds through a named view", () => {
    const persp = room();
    persp.setProjectionMode("persp");
    inside(persp);
    persp.setStandardView("front");
    settle(persp);
    expect(persp.isOrtho()).toBe(false);
    const ortho = room();
    ortho.setProjectionMode("ortho");
    inside(ortho);
    ortho.setStandardView("iso");
    settle(ortho);
    expect(ortho.isOrtho()).toBe(true);
  });

  it("after a click inside, a step off the axis is perspective and a later landing on an axis stays so", () => {
    const rig = room();
    inside(rig);
    rig.setStandardView("front");
    settle(rig);
    expect(rig.isOrtho()).toBe(true);
    const eye = rig.getPosition(v(0, 0, 0)).clone();
    expect(lookFrom(rig, v(eye.x + 14, eye.y, eye.z + 5))).toBe(false);
    expect(lookFrom(rig, v(0, -50, 0))).toBe(false);
    expect(lookFrom(rig, v(50, 0, 0))).toBe(false);
  });

  it("after a click inside, a zoom and a rebuild keep the orthographic view", () => {
    const rig = room();
    inside(rig);
    rig.setStandardView("front");
    settle(rig);
    for (let i = 0; i < 4; i++) {
      rig.zoomBy(0.7);
      settle(rig);
      expect(rig.isOrtho()).toBe(true);
    }
    rig.setContentBox(new THREE.Box3(v(-400, -400, -400), v(400, 400, 400)));
    settle(rig);
    expect(rig.isOrtho()).toBe(true);
  });

  it("a rebuild never turns a perspective view inside the box orthographic", () => {
    const rig = room();
    inside(rig);
    rig.setStandardView("iso");
    settle(rig);
    expect(rig.isOrtho()).toBe(false);
    rig.setViewDir(v(0, -1, 0), UP);
    settle(rig);
    rig.setContentBox(new THREE.Box3(v(-120, -120, -120), v(120, 120, 120)));
    settle(rig);
    expect(rig.isOrtho()).toBe(false);
  });

  it("a named view clicked while looking along another axis inside swaps the projection once, not on the way", () => {
    const rig = room();
    expect(lookFrom(rig, v(0, -50, 0))).toBe(false);
    rig.setStandardView("top");
    const seen: boolean[] = [rig.isOrtho()];
    for (let i = 0; i < 90; i++) {
      rig.update(1 / 60);
      seen.push(rig.isOrtho());
    }
    expect(seen.filter((o, i) => i > 0 && o !== seen[i - 1]).length).toBeLessThanOrEqual(1);
    expect(seen[seen.length - 1]).toBe(true);
  });

  it("the home view after a click inside is perspective", () => {
    const rig = room();
    inside(rig);
    rig.setStandardView("front");
    settle(rig);
    expect(rig.isOrtho()).toBe(true);
    rig.resetView(ROOM);
    settle(rig);
    expect(rig.isOrtho()).toBe(false);
  });
}
