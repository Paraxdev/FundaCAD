// A zoom's last stretch moves nothing a person can see but keeps restarting Path traced, so it lands early. How early
// goes by the nearest surface in view: scaling about an anchor moves a point by what is left of the log, times the
// point's pixels from the anchor, times anchor depth over point depth.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { H, W, BoxScene, maxDiff, pixel, screenPrint, settle, setup } from "./kit";
import { NearestSweep, ZOOM_SNAP_PX, zoomSnapLog } from "../../../src/viewport/navigator/zoomSnap";
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

/** The spring alone, to compare a landing with. */
function unsnapped<T extends { nav: Navigator }>(made: T): T {
  (made.nav as unknown as { zoomSnap(): number }).zoomSnap = () => 0;
  return made;
}

/** A notch on `make()` beside the same notch with the snap off: when each stops, and how far apart they are on screen
 *  at the landing. A tick's whole move also holds the spring's own step, this is only what the snap adds to it. */
function snapJump(make: () => { nav: Navigator }, watch: THREE.Vector3[], dt = DT) {
  const a = make().nav;
  const b = unsnapped(make()).nav;
  a.wheel(W / 2, H / 2, -NOTCH);
  b.wheel(W / 2, H / 2, -NOTCH);
  let landed = 0;
  let jump = 0;
  while (landed < 2000) {
    a.update(dt);
    b.update(dt);
    landed++;
    if (!a.isBusy()) {
      jump = maxDiff(screenPrint(a, watch), screenPrint(b, watch));
      break;
    }
  }
  return { landed, rest: landed + settle(b, dt), jump };
}

function nearestOf(nav: Navigator, scene: BoxScene): number | null {
  const sweep = new NearestSweep();
  while (!sweep.advance(nav.pose, { scene, plane: null, box: nav.contentBox(), frame: nav.frame }, Infinity));
  return sweep.nearest();
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

describe("NearestSweep", () => {
  it("finds a wall the eye stands beside at the frame's edge", () => {
    const { nav, scene } = room([box(-120, 0, -5000, -100, 5000, 5000)]);
    const halfW = Math.tan((nav.pose.fov * Math.PI) / 360) * (W / H);
    expect(nearestOf(nav, scene)).toBeCloseTo(100 / halfW, 3);
  });

  it("is null with nothing in view", () => {
    const nav = new Navigator();
    nav.setFrame(W, H);
    expect(nearestOf(nav, new BoxScene([]))).toBeNull();
  });

  it("sees a bar 50 px wide wherever it stands, either way up", () => {
    const depth = 500;
    const { nav } = room();
    const perPx = (2 * depth * Math.tan((nav.pose.fov * Math.PI) / 360)) / H;
    const missed: string[] = [];
    for (const across of [true, false]) {
      const span = across ? W : H;
      for (let at = 0; at + 50 <= span; at += 10) {
        const lo = (at - span / 2) * perPx;
        const hi = (at + 50 - span / 2) * perPx;
        const bar = across ? box(lo, depth, -5000, hi, depth + 1, 5000) : box(-5000, depth, -hi, 5000, depth + 1, -lo);
        const scene = new BoxScene([box(-5000, 1000, -5000, 5000, 1100, 5000), bar]);
        if (Math.abs(nearestOf(nav, scene)! - depth) > 1e-6) missed.push(`${across ? "x" : "y"}${at}`);
      }
    }
    expect(missed).toEqual([]);
  });

  it("casts at least one ray whatever the budget, and stops when it is spent", () => {
    const { nav, scene } = room();
    const sweep = new NearestSweep();
    scene.rays = 0;
    expect(sweep.advance(nav.pose, { scene, plane: null, box: null, frame: nav.frame }, 0)).toBe(false);
    expect(scene.rays).toBe(1);
  });
});

describe("a zoom's tail", () => {
  it("lands well before the spring's own rest", () => {
    const { nav } = room();
    const { frames } = tail(nav, [new THREE.Vector3(0, 1000, 0)]);
    expect(frames * DT).toBeLessThan(0.85);
  });

  it("adds at most the threshold to the nearest surface's move at the snap", () => {
    // A notch carries the eye to y 174, so the post stays ahead of it, at the frame's edge with the anchor on the far wall.
    const post = box(-130, 400, -5000, -110, 420, 5000);
    const watch = [
      new THREE.Vector3(-125, 400, 0),
      new THREE.Vector3(-125, 400, 60),
      new THREE.Vector3(-125, 400, -60),
    ];
    const { landed, rest, jump } = snapJump(() => room([post]), watch);
    expect(landed).toBeLessThan(rest);
    expect(jump).toBeGreaterThan(0);
    expect(jump).toBeLessThanOrEqual(ZOOM_SNAP_PX);
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
    nav.wheel(W / 2, H / 2, -NOTCH);
    nav.update(DT);
    scene.rays = 0;
    let frames = 0;
    let beforeLast = 0;
    while (nav.isBusy() && frames < 2000) {
      beforeLast = scene.rays;
      nav.update(DT);
      frames++;
    }
    // The last frame's one is the reseat at rest.
    expect(beforeLast).toBe(45);
    expect(scene.rays).toBeLessThanOrEqual(46);
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
    const spring = unsnapped(setup()).nav;
    const notches = [-120, -240, 120, 120, -120, -240, 240, 120, -120, 120];
    let frames = 0;
    let springFrames = 0;
    for (let i = 0; i < 40; i++) {
      for (const n of [nav, raw, spring]) n.wheel(W / 2, H / 2, notches[i % notches.length]!);
      frames += settle(nav);
      settle(raw);
      springFrames += settle(spring);
    }
    expect(frames).toBeLessThan(springFrames * 0.85);
    expect(Math.abs(nav.pose.scale / raw.pose.scale - 1)).toBeLessThan(1e-9);
    expect(nav.pose.target.distanceTo(raw.pose.target)).toBeLessThan(1e-6);
    expect(nav.pose.scale / spring.pose.scale).toBeCloseTo(1, 9);
    expect(nav.pose.target.distanceTo(spring.pose.target)).toBeLessThan(1e-6);
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

  it("looks over the view in the same frames with no orbit or pan moving it", () => {
    const { nav, scene } = room();
    nav.wheel(W / 2, H / 2, -NOTCH);
    nav.update(DT);
    scene.rays = 0;
    for (let i = 0; i < 40; i++) nav.update(DT);
    expect(scene.rays).toBeGreaterThan(0);
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

  it("takes a notch in the very frame it would have landed, and ends on both notches", () => {
    const { landed, rest } = snapJump(() => room(), []);
    expect(landed).toBeLessThan(rest);
    const { nav } = room();
    const s0 = nav.pose.scale;
    const wall = new THREE.Vector3(200, 1000, 100);
    nav.wheel(W / 2, H / 2, -NOTCH);
    for (let i = 0; i < landed - 1; i++) nav.update(DT);
    const before = pixel(nav, wall);
    nav.wheel(W / 2, H / 2, -NOTCH);
    nav.update(DT);
    const after = pixel(nav, wall);
    // One spring frame of a fresh notch, no landing.
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(5);
    expect(nav.isBusy()).toBe(true);
    settle(nav);
    expect(nav.pose.scale / (s0 * Math.exp(2 * -NOTCH * Math.log(1.0016)))).toBeCloseTo(1, 9);
  });

  describe("under auto projection, where a zoom out leaves the box and goes orthographic", () => {
    /** The eye on a world axis inside a box whose near face is at y `face`. */
    const auto = (face: number) => {
      const nav = new Navigator();
      nav.setFrame(W, H);
      const scene = new BoxScene([box(-9000, 1000, -9000, 9000, 1100, 9000)]);
      nav.setScene(scene);
      nav.setContentBox(box(-9000, face, -9000, 9000, 1100, 9000));
      nav.setProjectionMode("auto");
      nav.setLookAt(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1000, 0));
      settle(nav);
      return { nav, scene };
    };
    const out = (nav: Navigator) => {
      nav.wheel(W / 2, H / 2, NOTCH);
      return settle(nav);
    };

    it("ends in the projection the spring would have ended in, on the same pose", () => {
      const ended = [-60, -70, -80, -85, -88, -91, -95, -100, -120].map((face) => {
        const a = auto(face).nav;
        const b = unsnapped(auto(face)).nav;
        const frames = out(a);
        const springFrames = out(b);
        expect(frames).toBeLessThan(springFrames);
        expect(a.pose.scale / b.pose.scale).toBeCloseTo(1, 9);
        expect(a.pose.ortho).toBe(b.pose.ortho);
        return a.pose.ortho;
      });
      expect(ended).toContain(true);
      expect(ended).toContain(false);
    });

    it("casts nothing once it has gone orthographic", () => {
      const { nav, scene } = auto(-60);
      nav.wheel(W / 2, H / 2, NOTCH);
      let frames = 0;
      while (!nav.pose.ortho && frames++ < 2000) nav.update(DT);
      expect(nav.isBusy()).toBe(true);
      scene.rays = 0;
      settle(nav);
      expect(scene.rays).toBeLessThanOrEqual(1);
    });
  });

  describe("on a model where each ray costs time", () => {
    afterEach(() => vi.restoreAllMocks());

    const springTail = () => {
      const { nav } = unsnapped(room());
      nav.wheel(W / 2, H / 2, -NOTCH);
      return { frames: settle(nav), scale: nav.pose.scale };
    };

    /** A notch with every ray taking `ms` on a mocked clock: the most rays in one frame of the tail, and how it ended. */
    const slow = (ms: number) => {
      const { nav, scene } = room();
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const cast = scene.raycast.bind(scene);
      scene.raycast = (o, d) => {
        now += ms;
        return cast(o, d);
      };
      nav.wheel(W / 2, H / 2, -NOTCH);
      nav.update(DT);
      let most = 0;
      let frames = 1;
      while (nav.isBusy() && frames < 2000) {
        const before = scene.rays;
        nav.update(DT);
        frames++;
        // The last frame also reseats at rest.
        if (nav.isBusy()) most = Math.max(most, scene.rays - before);
      }
      return { most, frames, scale: nav.pose.scale };
    };

    it("spreads the rays over frames and still lands early on a middling model", () => {
      const { frames: rest } = springTail();
      const { most, frames } = slow(0.5);
      expect(most).toBeLessThanOrEqual(4);
      expect(frames).toBeLessThan(rest);
    });

    it("spends one ray a frame on a heavy model, which ends on its goal all the same", () => {
      const { frames: rest, scale } = springTail();
      const heavy = slow(20);
      expect(heavy.most).toBe(1);
      expect(heavy.frames).toBeLessThanOrEqual(rest);
      expect(heavy.scale / scale).toBeCloseTo(1, 9);
    });
  });

  it("casts nothing and keeps the spring's own rule while the scene says rays are costly", () => {
    const { nav, scene } = room();
    Object.assign(scene, { raysCostly: () => true });
    const spring = unsnapped(room()).nav;
    nav.wheel(W / 2, H / 2, -NOTCH);
    spring.wheel(W / 2, H / 2, -NOTCH);
    nav.update(DT);
    spring.update(DT);
    scene.rays = 0;
    const frames = settle(nav);
    expect(frames).toBe(settle(spring));
    expect(scene.rays).toBeLessThanOrEqual(1);
  });

  it.each([
    ["the model's box", (nav: Navigator) => nav.setContentBox(nav.contentBox())],
    ["the scene", (nav: Navigator, scene: BoxScene) => nav.setScene(scene)],
    ["the frame", (nav: Navigator) => nav.setFrame(W + 10, H)],
    ["the anchor plane", (nav: Navigator) => nav.setAnchorPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0))],
    ["an immediate zoom", (nav: Navigator) => nav.zoomBy(1.0001)],
  ])("looks over the view again when %s changes during the tail", (_name, change) => {
    const { nav, scene } = room();
    nav.wheel(W / 2, H / 2, -NOTCH);
    nav.update(DT);
    scene.rays = 0;
    let frames = 0;
    while (scene.rays === 0 && nav.isBusy() && frames++ < 2000) nav.update(DT);
    expect(nav.isBusy()).toBe(true);
    change(nav, scene);
    scene.rays = 0;
    nav.update(DT);
    expect(scene.rays).toBeGreaterThanOrEqual(45);
  });

  it("is instant at smooth time 0, as before", () => {
    const { nav } = room();
    nav.opts.smoothTime = 0;
    const { frames } = tail(nav, []);
    expect(frames).toBeLessThanOrEqual(2);
  });
});
