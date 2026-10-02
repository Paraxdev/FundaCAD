import { describe, expect, it } from "vitest";
import { MOTION_LEVELS, MotionQuality } from "../../src/viewport/motionQuality";

/** Feed `n` camera frames of `ms` each, starting at `t0`; returns the clock after. */
function feed(q: MotionQuality, ms: number, n: number, t0 = 0): number {
  let t = t0;
  for (let i = 0; i < n; i++) {
    t += ms;
    q.sample(ms, t);
  }
  return t;
}

describe("MotionQuality", () => {
  it("never leaves full quality on a GPU that keeps up", () => {
    const q = new MotionQuality();
    feed(q, 16.7, 200);
    feed(q, 7, 200);
    expect(q.scale).toBe(1);
  });

  it("leaves a 30 fps power-plan cap alone, a smaller canvas cannot help it", () => {
    const q = new MotionQuality();
    feed(q, 33.4, 200);
    expect(q.scale).toBe(1);
  });

  it("goes straight to the level the frame time says will fit", () => {
    const slow = new MotionQuality();
    feed(slow, 105, 4);
    expect(slow.scale).toBe(0.5);
    const middling = new MotionQuality();
    feed(middling, 50, 4);
    expect(middling.scale).toBe(0.75);
  });

  it("judges a median, so one long frame does not step it down", () => {
    const q = new MotionQuality();
    for (let i = 0; i < 10; i++) {
      q.sample(16.7, i);
      q.sample(16.7, i);
      q.sample(400, i);
      q.sample(16.7, i);
    }
    expect(q.scale).toBe(1);
  });

  it("ignores the frame that paid for the resize", () => {
    const q = new MotionQuality();
    feed(q, 105, 4);
    expect(q.level).toBe(2);
    q.sample(900, 500); // the resize itself, not judged
    feed(q, 36, 4, 500);
    expect(q.level).toBe(2);
  });

  it("undoes a step that bought nothing and does not try it again", () => {
    const q = new MotionQuality();
    let t = feed(q, 60, 4);
    expect(q.level).toBeGreaterThan(0);
    t = feed(q, 60, 5, t); // one skipped, then a verdict: no faster
    expect(q.level).toBe(0);
    t = feed(q, 60, 40, t);
    expect(q.level).toBe(0);
  });

  it("keeps the level across gestures while the machine is still slow", () => {
    const q = new MotionQuality();
    let t = feed(q, 105, 4);
    t = feed(q, 38, 9, t);
    q.settle(t);
    expect(q.level).toBe(2);
    feed(q, 38, 8, t);
    expect(q.level).toBe(2);
  });

  it("offers a level back after a gesture with headroom, once the slow one is forgotten", () => {
    const q = new MotionQuality();
    let t = feed(q, 105, 4);
    t = feed(q, 18, 5, t);
    q.settle(t);
    expect(q.level).toBe(2); // the level above was just measured slow
    t = feed(q, 18, 5, t + 60_000);
    q.settle(t);
    expect(q.level).toBe(1);
  });

  it("rises within a gesture when even the bigger canvas would fit", () => {
    const q = new MotionQuality();
    let t = feed(q, 50, 4);
    expect(q.level).toBe(1);
    t = feed(q, 36, 5, t); // pays off enough to stay
    expect(q.level).toBe(1);
    feed(q, 8, 5, t + 60_000);
    expect(q.level).toBe(0);
  });

  it("remembers what a full quality frame cost after it steps down", () => {
    const q = new MotionQuality();
    expect(q.fullPeriod(0)).toBe(0);
    let t = feed(q, 105, 4);
    t = feed(q, 38, 9, t);
    expect(q.level).toBe(2);
    expect(q.fullPeriod(t)).toBe(105);
    expect(q.fullPeriod(t + 60_000)).toBe(0); // too old to describe the machine now
    q.reset();
    expect(q.fullPeriod(t)).toBe(0);
  });

  it("starts over on reset", () => {
    const q = new MotionQuality();
    feed(q, 105, 4);
    q.reset();
    expect(q.scale).toBe(MOTION_LEVELS[0]);
  });

  it("climbs back once a busy GPU frees up, even on a model that is not pixel bound", () => {
    const q = new MotionQuality();
    let t = feed(q, 105, 4); // another app rendering: straight down
    t = feed(q, 60, 9, t);
    expect(q.level).toBe(2);
    // Now 25 ms at half size, which pixel pricing reads as 100 ms full size.
    t = feed(q, 25, 200, t + 30_000);
    expect(q.level).toBe(0);
  });

  it("steps back down from a level up that was too slow and does not retry it at once", () => {
    const q = new MotionQuality();
    let t = feed(q, 105, 4);
    t = feed(q, 25, 400, t + 30_000); // probes all the way back up
    expect(q.level).toBe(0);
    t = feed(q, 50, 4, t); // the other app is back
    expect(q.level).toBe(1);
    t = feed(q, 36, 5, t); // the step paid off
    expect(q.level).toBe(1);
    feed(q, 25, 400, t); // inside the memory window: no retry
    expect(q.level).toBe(1);
  });

  it("tries a level up at the end of a comfortable gesture", () => {
    const q = new MotionQuality();
    let t = feed(q, 105, 4);
    t = feed(q, 28, 5, t + 40_000);
    expect(q.level).toBe(1);
    q.settle(t);
    expect(q.level).toBe(1); // the rise was mid gesture, nothing measured since
  });

  it("climbs back on a laptop held to 30 fps once the busy GPU frees up", () => {
    const q = new MotionQuality();
    let t = feed(q, 105, 4);
    t = feed(q, 60, 9, t);
    expect(q.level).toBe(2);
    feed(q, 33.4, 400, t + 30_000);
    expect(q.level).toBe(0);
  });

  it("backs off a level up that keeps failing on a pixel bound machine", () => {
    const q = new MotionQuality();
    const cost = [60, 46, 15]; // what each level really costs
    let t = 0;
    let changes = 0;
    let last = q.level;
    for (let i = 0; i < 20_000; i++) {
      const ms = cost[q.level]!;
      t += ms;
      q.sample(ms, t);
      if (q.level !== last) {
        changes++;
        last = q.level;
      }
    }
    // About 5 minutes of motion: the old 30 s memory alone retried ten times.
    expect(t).toBeGreaterThan(290_000);
    expect(changes).toBeLessThan(10);
  });
});
