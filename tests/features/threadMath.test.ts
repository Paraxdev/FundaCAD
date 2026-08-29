// The arithmetic between "this cylindrical face is an M6 shank" and the two
// features a thread actually is. The kernel side of the same seam is pinned in
// sidecar/tests/test_thread_roundtrip.py — including the one that does not
// raise: a profile that only just touches the cylinder it cuts leaves the shank
// untouched, with no exception anywhere.

import { describe, it, expect } from "vitest";
import {
  MIN_THREAD_TURNS,
  THREAD_DEPTH_RATIO,
  THREAD_HALF_WIDTH_RATIO,
  coarsePitchFor,
  threadAngleDeg,
  threadProfile,
  threadTurns,
} from "../../src/features/threadMath";

describe("coarsePitchFor", () => {
  it("knows the sizes off a hardware drawer", () => {
    expect(coarsePitchFor(3)).toBe(0.5);
    expect(coarsePitchFor(4)).toBe(0.7);
    expect(coarsePitchFor(5)).toBe(0.8);
    expect(coarsePitchFor(6)).toBe(1);
    expect(coarsePitchFor(8)).toBe(1.25);
    expect(coarsePitchFor(10)).toBe(1.5);
    expect(coarsePitchFor(12)).toBe(1.75);
    expect(coarsePitchFor(20)).toBe(2.5);
  });

  it("still says M6 for a shaft measured off a mesh", () => {
    // This is the whole reason it snaps to the NEAREST size: a diameter read off
    // tessellated geometry is never exactly 6.
    expect(coarsePitchFor(5.9987)).toBe(1);
    expect(coarsePitchFor(6.0013)).toBe(1);
    expect(coarsePitchFor(5.7)).toBe(1);
  });

  it("carries the ratio on past both ends of the table", () => {
    expect(coarsePitchFor(0.8)).toBeGreaterThan(0);
    expect(coarsePitchFor(0.8)).toBeLessThan(0.35);
    expect(coarsePitchFor(120)).toBeGreaterThan(6);
  });

  it("answers something usable for nonsense rather than NaN", () => {
    expect(coarsePitchFor(0)).toBeGreaterThan(0);
    expect(coarsePitchFor(-4)).toBeGreaterThan(0);
    expect(coarsePitchFor(Number.NaN)).toBeGreaterThan(0);
  });
});

describe("threadProfile", () => {
  it("cuts INWARD on a shank and OUTWARD in a bore", () => {
    const shank = threadProfile(3, 1, true)!;
    const bore = threadProfile(3, 1, false)!;
    // the apex is the third point either way; only its side changes
    expect(shank[2]!.x).toBeLessThan(3);
    expect(bore[2]!.x).toBeGreaterThan(3);
    // ...and the open side is the other way round to match
    expect(shank[0]!.x).toBeGreaterThan(3);
    expect(bore[0]!.x).toBeLessThan(3);
  });

  it("is ISO deep: 0.6134 of the pitch from crest to root", () => {
    const p = threadProfile(10, 2.5, true)!;
    expect(10 - p[2]!.x).toBeCloseTo(2.5 * THREAD_DEPTH_RATIO, 6);
  });

  it("breaks out past the cylinder by enough for the boolean to bite", () => {
    // 0.01mm was measured to leave a ⌀20 shank untouched: the profile has to
    // CROSS the surface, not sit on it.
    const p = threadProfile(10, 2.5, true)!;
    expect(p[0]!.x - 10).toBeGreaterThan(0.1);
    const fine = threadProfile(1.5, 0.5, true)!;
    expect(fine[0]!.x - 1.5).toBeGreaterThanOrEqual(0.02);
  });

  it("stays shorter along the axis than one turn's climb", () => {
    // The kernel refuses a climbing revolve whose profile is taller than the
    // pitch, because consecutive turns would run into each other.
    for (const pitch of [0.35, 1, 2.5, 6]) {
      const p = threadProfile(20, pitch, true)!;
      const height = Math.max(...p.map((q) => q.y)) - Math.min(...p.map((q) => q.y));
      expect(height).toBeLessThan(pitch);
    }
    expect(2 * THREAD_HALF_WIDTH_RATIO).toBeLessThan(1);
  });

  it("has 60 degree flanks", () => {
    const p = threadProfile(10, 2, true)!;
    const depth = 10 - p[2]!.x;
    const half = p[1]!.y;
    expect((Math.atan2(half, depth) * 180) / Math.PI).toBeCloseTo(30, 4);
  });

  it("refuses a pitch too coarse for the diameter instead of reaching the axis", () => {
    expect(threadProfile(0.4, 6, true)).toBeNull();
    expect(threadProfile(0.05, 1, false)).toBeNull();
  });

  it("refuses nonsense", () => {
    expect(threadProfile(0, 1, true)).toBeNull();
    expect(threadProfile(5, 0, true)).toBeNull();
    expect(threadProfile(5, Number.NaN, true)).toBeNull();
  });
});

describe("threadAngleDeg", () => {
  it("winds on one turn per pitch", () => {
    expect(threadAngleDeg(10, 1)).toBeCloseTo(3600);
    expect(threadAngleDeg(20, 2.5)).toBeCloseTo(2880);
    expect(threadTurns(20, 2.5)).toBeCloseTo(8);
  });

  it("is zero for a thread with no length, so the tool can refuse it", () => {
    expect(threadAngleDeg(0, 1)).toBe(0);
    expect(threadAngleDeg(10, 0)).toBe(0);
    expect(threadTurns(0.5, 1)).toBeLessThan(MIN_THREAD_TURNS);
  });
});
