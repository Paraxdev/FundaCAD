// A zoom's last stretch moves nothing a person can see but keeps restarting Path traced, so it lands early. How early
// goes by the nearest surface in view: scaling about an anchor moves a point by what is left of the log, times the
// point's pixels from the anchor, times anchor depth over point depth.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { H, W, BoxScene, maxDiff, pixel, screenPrint, settle, setup } from "./kit";
import { NearestSweep, ZOOM_SNAP_PX, nearestBound, zoomSnapLog } from "../../../src/viewport/navigator/zoomSnap";
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
  return { landed, rest: landed + framesLeft(b, dt), jump };
}

function framesLeft(nav: Navigator, dt = DT) {
  let frames = 0;
  while (nav.isBusy() && frames < 2000) {
    nav.update(dt);
    frames++;
  }
  return frames;
}

/** The frames the spring alone would still take on `nav`'s first zoom. */
function framesToLanding(nav: Navigator) {
  const [ch] = (nav as unknown as { zooms: ZoomChannel[] }).zooms;
  return ch ? ch.framesLeft(nav.opts.smoothTime, DT) : 0;
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

describe("nearestBound", () => {
  it("goes by what the rays saw when nothing in the parts can be nearer", () => {
    expect([nearestBound(300, 300, false, 1000), nearestBound(300, 900, false, 1000)]).toEqual([300, 300]);
  });

  it("goes by the anchor when the rays saw nothing nearer", () => {
    expect([nearestBound(4000, 4000, false, 1000), nearestBound(null, 1000, false, 1000)]).toEqual([1000, 1000]);
  });

  it("drops to the nearest box the eye is outside of, however far below the rays, as no surface of it can pass", () => {
    expect([nearestBound(800, 200, false, 1000), nearestBound(800, 50, false, 1000)]).toEqual([200, 50]);
  });

  it("trusts the rays to within a factor inside a box, where it says nothing", () => {
    expect([nearestBound(800, NaN, true, 1000), nearestBound(null, NaN, true, 1000)]).toEqual([100, 125]);
  });

  it("still drops to a box the eye is outside of from inside another", () => {
    expect([nearestBound(800, 50, true, 1000), nearestBound(800, 300, true, 1000)]).toEqual([50, 100]);
  });

  it("has the rays alone with no part in the frustum, as nothing thin can be there", () => {
    expect([nearestBound(800, NaN, false, 1000), nearestBound(null, NaN, false, 1000)]).toEqual([800, null]);
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

  it("casts none orthographic, and lands all the same", () => {
    const { nav, scene } = room([], true);
    scene.rays = 0;
    const { frames } = tail(nav, []);
    expect(scene.rays).toBeLessThanOrEqual(17 + 1);
    expect(frames * DT).toBeLessThan(0.85);
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

  describe("with a thin part between the rays, much nearer than anything they saw", () => {
    const EYE_END = 174;
    const wall = () => box(-5000, 1000, -5000, 5000, 1100, 5000);
    const behind = () => box(-5000, -500, -5000, 5000, -400, 5000);

    /** A pole `ratio` times nearer than the wall when the notch ends, 290 px left of the anchor by then. */
    const pole = (ratio: number) => {
      const depth = (1000 - EYE_END) / ratio;
      const tanV = Math.tan((makePose().fov * Math.PI) / 360);
      const x = (290 / (H / 2)) * tanV * depth;
      // Under a pixel wide when the notch ends, so no ray meets it.
      const half = depth / 4000;
      return {
        part: box(-x - half, EYE_END + depth, -5000, -x + half, EYE_END + depth + 2 * half, 5000),
        watch: [new THREE.Vector3(-x, EYE_END + depth, 0)],
      };
    };
    const scene = (parts: THREE.Box3[], given?: THREE.Box3[]) => () => {
      const nav = new Navigator();
      nav.setFrame(W, H);
      const s = new BoxScene(parts);
      nav.setScene(s);
      nav.setContentBox(s.box(), given);
      nav.setProjectionMode("persp");
      nav.setLookAt(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1000, 0));
      settle(nav);
      return { nav, scene: s };
    };

    // What the snap may add: the threshold, or its share past the factor the rays are trusted to.
    const most = (ratio: number) => ZOOM_SNAP_PX * Math.max(1, ratio / 8);

    it.each([6.4, 20, 100])("holds the jump to the threshold at %f:1 with the eye outside the model's box", (ratio) => {
      const { part, watch } = pole(ratio);
      const made = scene([wall(), part]);
      expect(nearestOf(made().nav, made().scene)).toBeGreaterThan(900);
      const { landed, rest, jump } = snapJump(made, watch);
      expect(landed).toBeLessThan(rest);
      expect(jump).toBeGreaterThan(0);
      expect(jump).toBeLessThanOrEqual(ZOOM_SNAP_PX);
    });

    it.each([6.4, 20, 100])(
      "holds the jump to the threshold at %f:1 from inside a body, the part being another",
      (ratio) => {
        const { part, watch } = pole(ratio);
        const hull = box(-5000, -500, -5000, 5000, 1100, 5000);
        const { landed, rest, jump } = snapJump(scene([wall(), behind(), part], [hull, part]), watch);
        expect(landed).toBeLessThan(rest);
        expect(jump).toBeGreaterThan(0);
        expect(jump).toBeLessThanOrEqual(ZOOM_SNAP_PX);
      },
    );

    it.each([6.4, 20, 100])("keeps the jump small at %f:1 from inside one body, where no box helps", (ratio) => {
      const { part, watch } = pole(ratio);
      const { landed, rest, jump } = snapJump(scene([wall(), behind(), part]), watch);
      expect(landed).toBeLessThan(rest);
      expect(jump).toBeGreaterThan(0);
      expect(jump).toBeLessThanOrEqual(most(ratio));
    });

    it("lands as early from inside the model as from outside it when its parts show nothing near", () => {
      const outside = snapJump(scene([wall()]), []).landed;
      const parted = snapJump(scene([wall(), behind()], [wall(), behind()]), []).landed;
      const oneBody = snapJump(scene([wall(), behind()]), []).landed;
      expect(parted).toBe(outside);
      expect(oneBody).toBeGreaterThan(parted);
      expect(oneBody * DT).toBeLessThan(0.85);
    });
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

    const springTail = (dt = DT) => {
      const { nav } = unsnapped(room());
      nav.wheel(W / 2, H / 2, -NOTCH);
      nav.update(dt);
      return { frames: 1 + framesLeft(nav, dt), scale: nav.pose.scale };
    };

    /** A notch with each ray taking `ms(n)` on a mocked clock: rays cast in the tail, the most in one frame of it, how it
     *  ended. */
    const slow = (ms: (n: number) => number, dt = DT) => {
      const { nav, scene } = room();
      let now = 0;
      let n = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const cast = scene.raycast.bind(scene);
      scene.raycast = (o, d) => {
        now += ms(n++);
        return cast(o, d);
      };
      nav.wheel(W / 2, H / 2, -NOTCH);
      nav.update(dt);
      n = 0;
      const start = scene.rays;
      let most = 0;
      let frames = 1;
      while (nav.isBusy() && frames < 2000) {
        const before = scene.rays;
        nav.update(dt);
        frames++;
        // The last frame also reseats at rest.
        if (nav.isBusy()) most = Math.max(most, scene.rays - before);
      }
      return { rays: scene.rays - start, most, frames, scale: nav.pose.scale };
    };

    it("spreads the rays over frames and still lands early on a middling model", () => {
      const { frames: rest } = springTail();
      const { most, frames } = slow(() => 0.5);
      expect(most).toBeLessThanOrEqual(4);
      expect(frames).toBeLessThan(rest);
    });

    it.each([2, 5, 15, 40])(
      "gives up after two frames of %d ms rays, which could not finish before the spring",
      (ms) => {
        const { frames: rest, scale } = springTail();
        const heavy = slow(() => ms);
        // The reseat at rest is the third.
        expect(heavy.rays).toBe(3);
        expect(heavy.frames).toBe(rest);
        expect(heavy.scale / scale).toBeCloseTo(1, 9);
      },
    );

    it("keeps going at one ray a frame when the frames are quick enough for it to pay", () => {
      const dt = 1 / 144;
      const { frames: rest } = springTail(dt);
      const { most, frames } = slow(() => 3, dt);
      expect(most).toBe(1);
      expect(frames).toBeLessThan(rest - 20);
    });

    it("is not put off by one slow ray", () => {
      const { frames: rest } = springTail();
      const { frames } = slow((n) => (n === 0 ? 40 : 0.01));
      expect(frames).toBeLessThan(rest - 10);
    });

    it("stays given up through the small steps of a pinch running out", () => {
      const { nav, scene } = room();
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const cast = scene.raycast.bind(scene);
      scene.raycast = (o, d) => {
        now += 20;
        return cast(o, d);
      };
      nav.wheel(W / 2, H / 2, -NOTCH);
      while (framesToLanding(nav) > 35) nav.update(DT);
      scene.rays = 0;
      for (let f = 0; f < 30; f++) {
        nav.wheel(W / 2, H / 2, -0.001, true);
        nav.update(DT);
      }
      expect(scene.rays).toBeLessThanOrEqual(3);
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

  it.each([1 / 30, 1 / 10])("adds at most the threshold on frames of %f s", (dt) => {
    const post = box(-130, 400, -5000, -110, 420, 5000);
    const { landed, rest, jump } = snapJump(() => room([post]), [new THREE.Vector3(-125, 400, 0)], dt);
    expect(landed).toBeLessThan(rest);
    expect(jump).toBeLessThanOrEqual(ZOOM_SNAP_PX);
  });

  describe("under a pinch stream that runs out, each step well under the sweep's reach", () => {
    const stream = (nav: Navigator, frames: number, step: (f: number) => number) => {
      for (let f = 0; f < frames; f++) {
        nav.wheel(W / 2, H / 2, step(f), true);
        nav.update(DT);
      }
    };

    it("keeps its look over the view rather than casting again every frame", () => {
      const { nav, scene } = room();
      const spring = unsnapped(room()).nav;
      scene.rays = 0;
      for (const n of [nav, spring]) stream(n, 200, (f) => -4 * 0.97 ** f);
      settle(nav);
      settle(spring);
      expect(scene.rays).toBeLessThan(45 * 3);
      expect(nav.pose.scale / spring.pose.scale).toBeCloseTo(1, 9);
    });

    it("looks again once a steady stream has carried the goal past the look's reach", () => {
      const { nav, scene } = room();
      // Slow enough to count as near the goal all the while, on a channel a notch keeps from landing at the first step.
      const steady = () => -0.018;
      nav.wheel(W / 2, H / 2, -NOTCH);
      stream(nav, 120, steady);
      scene.rays = 0;
      stream(nav, 240, steady);
      expect(scene.rays).toBeGreaterThanOrEqual(45);
      expect(scene.rays).toBeLessThan(45 * 60);
    });
  });

  it.each([
    ["all in one frame", 0],
    ["a frame apart", 1],
    ["three frames apart", 3],
  ])("shares the threshold between notches at four spots, %s", (_name, gap) => {
    const spots: [number, number][] = [
      [100, 100],
      [W - 100, 100],
      [100, H - 100],
      [W - 100, H - 100],
    ];
    const watch = [
      new THREE.Vector3(-900, 1000, -500),
      new THREE.Vector3(900, 1000, 500),
      new THREE.Vector3(0, 1000, 0),
    ];
    const a = room().nav;
    const b = unsnapped(room()).nav;
    let worst = 0;
    for (let f = 0; f < 400; f++) {
      if (gap === 0 ? f === 0 : f % gap === 0 && f / gap < 4) {
        const at = gap === 0 ? spots : spots.slice(f / gap, f / gap + 1);
        for (const [x, y] of at) {
          a.wheel(x, y, -NOTCH);
          b.wheel(x, y, -NOTCH);
          a.update(0);
          b.update(0);
        }
      }
      a.update(DT);
      b.update(DT);
      worst = Math.max(worst, maxDiff(screenPrint(a, watch), screenPrint(b, watch)));
    }
    expect(a.isBusy()).toBe(false);
    expect(worst).toBeLessThanOrEqual(ZOOM_SNAP_PX);
  });

  it("knows how many frames the spring has left", () => {
    const ch = new ZoomChannel(new THREE.Vector3(), 0, 0);
    ch.add(0.2);
    for (let f = 0; f < 5; f++) ch.step(0.125, DT);
    const said = ch.framesLeft(0.125, DT);
    let frames = 0;
    while (ch.left() > 0) {
      ch.step(0.125, DT);
      frames++;
    }
    expect(said).toBe(frames);
  });

  it("is instant at smooth time 0, as before", () => {
    const { nav } = room();
    nav.opts.smoothTime = 0;
    const { frames } = tail(nav, []);
    expect(frames).toBeLessThanOrEqual(2);
  });
});
