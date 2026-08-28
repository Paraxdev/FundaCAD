// The path a climbing revolve's profile travels. The dashed helix the pitch
// arrow draws and the spine the sidecar sweeps along come from the same rule, so
// anything wrong here is a preview that lies about where the geometry is going.
//
// The sign conventions are the point of this file. The angle decides which way
// the sweep turns and the pitch decides which way it climbs, INDEPENDENTLY, and
// all four combinations are different solids. sidecar/tests/test_thread_revolve.py
// asserts the same four on the built geometry.
import { describe, expect, it } from "vitest";
import {
  clampDragPitch,
  helixSegments,
  pitchFromRise,
  revolveAxis,
  riseOf,
  screwPath,
  turnsOf,
  unit,
} from "../../src/features/screwMath";
import type { Vec3 } from "../../src/types";

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;
const Z = { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 };
const AT: Vec3 = [8, 0, 0]; // a profile 8mm out from the Z axis, level with the origin

describe("revolveAxis", () => {
  it("names the three world axes", () => {
    expect(revolveAxis("X")).toEqual({ origin: [0, 0, 0], dir: [1, 0, 0] });
    expect(revolveAxis("Y")).toEqual({ origin: [0, 0, 0], dir: [0, 1, 0] });
    expect(revolveAxis("Z")).toEqual({ origin: [0, 0, 0], dir: [0, 0, 1] });
  });

  it("reads a line, and normalises it", () => {
    const a = revolveAxis({ origin: [1, 2, 3], dir: [0, 0, 5] });
    expect(a.origin).toEqual([1, 2, 3]);
    expect(a.dir).toEqual([0, 0, 1]);
  });

  it("falls back to Z rather than returning a zero direction", () => {
    // A zero vector is not an axis. Passing one through would make every dot
    // product zero and put the whole path on top of the profile.
    expect(revolveAxis({ origin: [0, 0, 0], dir: [0, 0, 0] }).dir).toEqual([0, 0, 1]);
    expect(unit([0, 0, 0])).toBeNull();
  });
});

describe("pitch, turns and rise", () => {
  it("counts turns with a sign", () => {
    expect(turnsOf(3600)).toBe(10);
    expect(turnsOf(-720)).toBe(-2);
  });

  it("rises pitch per turn, not pitch in total", () => {
    // The whole reason the field is called Pitch: ten turns of a 1.5mm thread
    // are 15mm long, and the number typed off the spec stays 1.5.
    expect(riseOf(3600, 1.5)).toBe(15);
    expect(riseOf(360, 1.5)).toBe(1.5);
  });

  it("inverts back to a pitch, which is what a drag means", () => {
    expect(pitchFromRise(15, 3600)).toBe(1.5);
    expect(pitchFromRise(riseOf(655, 7.4), 655)).toBeCloseTo(7.4, 12);
  });

  it("has no answer for zero turns, and says so", () => {
    // Rather than an Infinity that would travel all the way to the kernel.
    expect(pitchFromRise(5, 0)).toBeNull();
  });
});

describe("clampDragPitch", () => {
  it("holds a multi-turn drag to a climb that clears the profile", () => {
    expect(clampDragPitch(0.28, 1, 3600)).toBe(1);
    expect(clampDragPitch(-0.28, 1, 3600)).toBe(-1);
    expect(clampDragPitch(2.5, 1, 3600)).toBe(2.5);
  });

  it("leaves a single turn alone: there is no next turn to run into", () => {
    expect(clampDragPitch(0.28, 1, 360)).toBe(0.28);
    expect(clampDragPitch(0.28, 1, -360)).toBe(0.28);
  });

  it("keeps zero reachable, because zero is the flat revolve", () => {
    // Clamping zero up to the minimum would make it impossible to take a thread
    // back to being a plain revolve by dragging.
    expect(clampDragPitch(0, 1, 3600)).toBe(0);
  });

  it("clamps nothing when the profile could not be measured", () => {
    expect(clampDragPitch(0.28, 0, 3600)).toBe(0.28);
  });
});

describe("screwPath", () => {
  it("starts at the profile and ends a full rise above it", () => {
    const p = screwPath(AT, Z, 3600, 1.5);
    expect(p[0]!.map((n) => +n.toFixed(9))).toEqual([8, 0, 0]);
    const end = p[p.length - 1]!;
    expect(close(end[0], 8, 1e-6)).toBe(true);
    expect(close(end[1], 0, 1e-6)).toBe(true);
    expect(close(end[2], 15, 1e-6)).toBe(true); // ten turns at 1.5
  });

  it("keeps the profile's radius the whole way round", () => {
    for (const q of screwPath(AT, Z, 655, 7.4)) {
      expect(close(Math.hypot(q[0], q[1]), 8, 1e-6)).toBe(true);
    }
  });

  it("turns the way the angle says and climbs the way the pitch says", () => {
    // Four sign pairs, four different curves. This is the property that broke
    // first when the drag was wired up: the two must not steer each other.
    const quarter = (angle: number, pitch: number) => {
      const p = screwPath(AT, Z, angle, pitch, 4);
      return p[1]!; // one quarter of the way along
    };
    expect(quarter(360, 2)[1]).toBeGreaterThan(0); // +angle: anticlockwise
    expect(quarter(-360, 2)[1]).toBeLessThan(0); // -angle: clockwise
    expect(quarter(360, 2)[2]).toBeGreaterThan(0); // +pitch: rising
    expect(quarter(360, -2)[2]).toBeLessThan(0); // -pitch: falling
    // and a backwards turn with a forward pitch falls, because rise is turns x pitch
    expect(quarter(-360, 2)[2]).toBeLessThan(0);
    expect(quarter(-360, -2)[2]).toBeGreaterThan(0);
  });

  it("is a flat circle with no pitch", () => {
    for (const q of screwPath(AT, Z, 360, 0)) expect(close(q[2], 0)).toBe(true);
  });

  it("works about an axis that is neither world-aligned nor through the origin", () => {
    const axis = { origin: [10, 0, 0] as Vec3, dir: [0, 1, 0] as Vec3 };
    const at: Vec3 = [10, 5, 3]; // 3mm off that axis, 5mm along it
    const p = screwPath(at, axis, 720, 2);
    const end = p[p.length - 1]!;
    // two turns at 2mm carries it 4mm further along the axis, radius unchanged
    expect(close(end[1], 9, 1e-6)).toBe(true);
    for (const q of p) {
      expect(close(Math.hypot(q[0] - 10, q[2]), 3, 1e-6)).toBe(true);
    }
  });

  it("refuses a profile sitting on the axis", () => {
    // No meridian to start from, and no radius to sweep: the same refusal the
    // sidecar makes, so the arrow is never offered for an impossible gesture.
    expect(screwPath([0, 0, 4], Z, 360, 1)).toEqual([]);
  });

  it("refuses an axis with no direction", () => {
    expect(screwPath(AT, { origin: [0, 0, 0], dir: [0, 0, 0] }, 360, 1)).toEqual([]);
  });
});

describe("helixSegments", () => {
  it("gives a turn enough points to look round", () => {
    expect(helixSegments(360)).toBe(16);
    expect(helixSegments(3600)).toBe(160);
  });

  it("never returns fewer than a line needs", () => {
    expect(helixSegments(1)).toBe(2);
    expect(helixSegments(0)).toBe(2);
  });

  it("caps a spring, which would otherwise rebuild thousands of vertices a frame", () => {
    expect(helixSegments(360 * 1000)).toBe(2000);
  });
});
