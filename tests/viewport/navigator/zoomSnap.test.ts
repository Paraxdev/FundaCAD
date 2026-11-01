// A zoom's last stretch moves nothing a person can see but keeps restarting Path traced, so it lands early. How early
// goes by the nearest surface in view: scaling about an anchor moves a point by what is left of the log, times the
// point's pixels from the anchor, times anchor depth over point depth.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { H, W, BoxScene, maxDiff, pixel, screenPrint, settle, setup } from "./kit";
import { ZOOM_SNAP_PX, nearestDepth, zoomSnapLog } from "../../../src/viewport/navigator/zoomSnap";
import { ZoomChannel } from "../../../src/viewport/navigator/channels";
import { Navigator } from "../../../src/viewport/navigator/navigator";
import { makePose } from "../../../src/viewport/navigator/pose";

const DT = 1 / 60;
const NOTCH = 120;
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
  new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));

/** Looking along +Y from the origin at a far wall, with whatever else is given. */
function room(extra: THREE.Box3[] = [], ortho = false) {
  const wall = box(-5000, 1000, -5000, 5000, 1100, 5000);
  const nav = new Navigator();
  nav.setFrame(W, H);
  const scene = new BoxScene([wall, ...extra]);
  nav.setScene(scene);
  nav.setContentBox(scene.box());
  nav.setProjectionMode(ortho ? "ortho" : "persp");
  nav.setLookAt(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1000, 0));
  settle(nav);
  return { nav, scene };
}

/** Frames from a notch until the view stops, and the last frame's move at `watch`. */
function tail(nav: Navigator, watch: THREE.Vector3[], x = W / 2, y = H / 2, delta = -NOTCH) {
  nav.wheel(x, y, delta);
  let frames = 0;
  let prev = screenPrint(nav, watch);
  let lastMove = 0;
  while (frames < 2000) {
    const moved = nav.update(DT);
    frames++;
    const now = screenPrint(nav, watch);
    if (moved) lastMove = maxDiff(prev, now);
    prev = now;
    if (!moved && !nav.isBusy()) break;
  }
  return { frames, lastMove };
}

describe("zoomSnapLog", () => {
  const anchorAt = (depth: number) => new THREE.Vector3(0, depth, 0);
  const persp = () => {
    const p = makePose();
    p.q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    p.target.set(0, 1000, 0);
    p.scale = 1000 * Math.tan((p.fov * Math.PI) / 360);
    return p;
  };
  const R = Math.hypot(W / 2, H / 2);

  it("is the threshold over the frame radius when the anchor is the nearest thing", () => {
    expect(zoomSnapLog(persp(), { width: W, height: H }, anchorAt(1000), 1000)).toBeCloseTo(ZOOM_SNAP_PX / R, 12);
  });

  it("shrinks by anchor depth over nearest depth", () => {
    expect(zoomSnapLog(persp(), { width: W, height: H }, anchorAt(1000), 50)).toBeCloseTo(
      (ZOOM_SNAP_PX / R) * 0.05,
      12,
    );
  });

  it("does not grow for a nearest surface behind the anchor", () => {
    expect(zoomSnapLog(persp(), { width: W, height: H }, anchorAt(1000), 4000)).toBeCloseTo(ZOOM_SNAP_PX / R, 12);
  });

  it("measures from the anchor's pixel, so an anchor in a corner has further to reach", () => {
    const p = persp();
    const offCentre = new THREE.Vector3(1000 * Math.tan((p.fov * Math.PI) / 360) * (W / H), 1000, 0);
    const at = zoomSnapLog(p, { width: W, height: H }, offCentre, 1000);
    expect(at).toBeCloseTo(ZOOM_SNAP_PX / Math.hypot(W, H / 2), 12);
  });

  it("ignores depth when orthographic, every point scales alike", () => {
    const p = persp();
    p.ortho = true;
    expect(zoomSnapLog(p, { width: W, height: H }, anchorAt(1000), 1)).toBeCloseTo(ZOOM_SNAP_PX / R, 12);
  });

  it("has no surface to answer to with nothing in view", () => {
    expect(zoomSnapLog(persp(), { width: W, height: H }, anchorAt(1000), null)).toBeCloseTo(ZOOM_SNAP_PX / R, 12);
  });
});

describe("nearestDepth", () => {
  it("finds a wall the eye stands beside at the frame's edge", () => {
    const { nav, scene } = room([box(-120, 0, -5000, -100, 5000, 5000)]);
    const d = nearestDepth(nav.pose, { scene, plane: null, box: nav.contentBox(), frame: nav.frame });
    const halfW = Math.tan((nav.pose.fov * Math.PI) / 360) * (W / H);
    expect(d).toBeCloseTo(100 / halfW, 3);
  });

  it("is null with nothing in view", () => {
    const nav = new Navigator();
    nav.setFrame(W, H);
    expect(nearestDepth(nav.pose, { scene: new BoxScene([]), plane: null, box: null, frame: nav.frame })).toBeNull();
  });
});

describe("a zoom's tail", () => {
  it("lands well before the spring's own rest", () => {
    const { nav } = room();
    const { frames } = tail(nav, [new THREE.Vector3(0, 1000, 0)]);
    expect(frames * DT).toBeLessThan(0.85);
  });

  it("never moves the nearest surface by more than the threshold at the snap", () => {
    // A notch carries the eye to y 174, so the post stays ahead of it, at the frame's edge with the anchor on the far wall.
    const post = box(-130, 400, -5000, -110, 420, 5000);
    const { nav } = room([post]);
    const watch = [
      new THREE.Vector3(-125, 400, 0),
      new THREE.Vector3(-125, 400, 60),
      new THREE.Vector3(-125, 400, -60),
    ];
    const { lastMove } = tail(nav, watch);
    expect(lastMove).toBeGreaterThan(0);
    expect(lastMove).toBeLessThanOrEqual(ZOOM_SNAP_PX * Math.SQRT2);
  });

  it("waits longer the closer the nearest surface is", () => {
    const far = room();
    const near = room([box(-120, 0, -5000, -100, 5000, 5000)]);
    const a = tail(far.nav, [new THREE.Vector3(0, 1000, 0)]);
    const b = tail(near.nav, [new THREE.Vector3(-100, 500, 0)]);
    expect(b.frames).toBeGreaterThan(a.frames);
    expect(b.lastMove).toBeLessThanOrEqual(ZOOM_SNAP_PX * Math.SQRT2);
  });

  it("keeps the spring's own rule with a surface at the eye", () => {
    const { nav } = room([box(-0.201, 0, -5000, -0.2, 5000, 5000)]);
    const { frames } = tail(nav, []);
    // Amplified past the spring's floor: about 1.09 s, as before.
    expect(frames * DT).toBeGreaterThan(1);
  });

  it("casts its rays once, not every frame", () => {
    const { nav, scene } = room();
    scene.rays = 0;
    tail(nav, []);
    // One anchor, one reseat, one look over the view.
    expect(scene.rays).toBeLessThanOrEqual(17 + 1 + 45);
  });

  it("casts none orthographic", () => {
    const { nav, scene } = room([], true);
    scene.rays = 0;
    tail(nav, []);
    expect(scene.rays).toBeLessThanOrEqual(17 + 1);
  });

  it("lands on the same goal as the spring would, over many notches", () => {
    const { nav } = setup();
    const raw = setup({ tau: 0 }).nav;
    const notches = [-120, -240, 120, 120, -120, -240, 240, 120, -120, 120];
    for (let i = 0; i < 40; i++) {
      for (const n of [nav, raw]) {
        n.wheel(W / 2, H / 2, notches[i % notches.length]!);
        settle(n);
      }
    }
    expect(Math.abs(nav.pose.scale / raw.pose.scale - 1)).toBeLessThan(1e-9);
    expect(nav.pose.target.distanceTo(raw.pose.target)).toBeLessThan(1e-6);
  });

  it("feeds a notch in the tail to the same channel, without a jump", () => {
    const { nav } = room();
    const wall = new THREE.Vector3(200, 1000, 100);
    nav.wheel(W / 2, H / 2, -NOTCH);
    for (let i = 0; i < 24; i++) nav.update(DT);
    const before = pixel(nav, wall);
    nav.wheel(W / 2, H / 2, -NOTCH);
    nav.update(DT);
    const after = pixel(nav, wall);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(5);
    const s = nav.pose.scale;
    settle(nav);
    expect(nav.pose.scale).toBeLessThan(s);
  });

  it("takes a notch after the snap as a new zoom that still ends on its goal", () => {
    const { nav } = room();
    const s0 = nav.pose.scale;
    const a = tail(nav, []);
    const b = tail(nav, []);
    expect(a.frames * DT).toBeLessThan(0.85);
    expect(b.frames * DT).toBeLessThan(0.85);
    // Each notch is a factor about the anchor, which reseats keep on the same depth here.
    const expected = s0 * Math.exp(2 * -NOTCH * Math.log(1.0016));
    expect(Math.abs(nav.pose.scale / expected - 1)).toBeLessThan(1e-9);
  });

  it("does not snap a reversal crossing its goal at speed", () => {
    const ch = new ZoomChannel(new THREE.Vector3(), 0, 0);
    ch.add(0.2);
    for (let i = 0; i < 6; i++) ch.step(0.125, DT);
    const x = 0.2 - ch.left();
    ch.add(x - ch.goal);
    expect(ch.left()).toBe(0);
    ch.step(0.125, DT, 1e-3);
    expect(ch.settled()).toBe(false);
  });

  it("leaves a zoom alone while an orbit or a pan is moving the view", () => {
    const { nav, scene } = room();
    nav.wheel(W / 2, H / 2, -NOTCH);
    nav.update(DT);
    nav.beginOrbit(W / 2, H / 2);
    nav.dragTo(W / 2 + 30, H / 2);
    scene.rays = 0;
    for (let i = 0; i < 40; i++) nav.update(DT);
    expect(scene.rays).toBe(0);
    nav.endGesture();
  });

  it("is instant at smooth time 0, as before", () => {
    const { nav } = room();
    nav.opts.smoothTime = 0;
    const { frames } = tail(nav, []);
    expect(frames).toBeLessThanOrEqual(2);
  });
});
