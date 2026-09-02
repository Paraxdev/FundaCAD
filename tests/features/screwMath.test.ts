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
  MAX_ARC_DEG,
  MAX_DRAG_TURNS,
  MIN_DRAG_ANGLE,
  arcSpanDeg,
  clampDragAngle,
  clampDragPitch,
  helixSegments,
  pitchFromRise,
  revolveAxis,
  riseOf,
  screwPath,
  sweepArc,
  turnsOf,
  unit,
  unwrapTurn,
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

describe("unwrapTurn", () => {
  it("leaves a small step alone", () => {
    expect(unwrapTurn(10, 25)).toBe(25);
    expect(unwrapTurn(10, -5)).toBe(-5);
  });

  it("carries a drag forward across the seam instead of unwinding it", () => {
    // The bug it exists for: the cursor reads +179, then -179, and a sweep that
    // has just completed a turn springs back a whole circle.
    expect(unwrapTurn(179, -179)).toBe(181);
    expect(unwrapTurn(-179, 179)).toBe(-181);
  });

  it("keeps counting past the first turn", () => {
    // Ten turns is an ordinary thread, so the count has to survive ten seams.
    // The hand travels in 30 degree steps, which is what makes this a test:
    // every reading is folded into [-180, 180) and only the accumulator knows
    // which turn it is on.
    const fold = (d: number) => d - 360 * Math.floor((d + 180) / 360);
    let prev = 0;
    for (let step = 1; step <= 120; step++) {
      prev = unwrapTurn(prev, fold(step * 30));
    }
    expect(prev).toBeCloseTo(3600, 9);
  });

  it("holds the previous value rather than emitting a NaN", () => {
    expect(unwrapTurn(720, NaN)).toBe(720);
  });

  it("takes the raw reading when there is no previous one", () => {
    expect(unwrapTurn(NaN, 45)).toBe(45);
  });
});

describe("clampDragAngle", () => {
  const TALL = 3; // a profile 3mm tall along the axis

  it("passes an ordinary sweep through", () => {
    expect(clampDragAngle(180, 5, TALL)).toBe(180);
    expect(clampDragAngle(-270, 5, TALL)).toBe(-270);
  });

  it("stops a flat revolve at one turn", () => {
    // More than 360 with no climb re-sweeps the same solid: there is nothing
    // past the first turn to find, so the arrow should not travel there.
    expect(clampDragAngle(540, 0, TALL)).toBe(360);
    expect(clampDragAngle(-540, 0, TALL)).toBe(-360);
  });

  it("stops at one turn while the climb is shorter than the profile is tall", () => {
    // The wall the user is meant to feel: turn two would run into turn one, and
    // the sidecar refuses that build. clampDragPitch draws the same line from
    // the pitch side.
    expect(clampDragAngle(400, TALL - 0.5, TALL)).toBe(360);
    expect(clampDragPitch(TALL - 0.5, TALL, 400)).toBe(TALL);
  });

  it("opens up the moment the climb clears the profile", () => {
    expect(clampDragAngle(400, TALL, TALL)).toBe(400);
    expect(clampDragAngle(3600, TALL + 1, TALL)).toBe(3600);
  });

  it("clamps nothing but the far cap when the profile could not be measured", () => {
    // minPitch 0 means "not measured", not "no height" — the kernel's own
    // refusal is the backstop there, exactly as it is for the pitch drag.
    expect(clampDragAngle(3600, 5, 0)).toBe(3600);
  });

  it("still stops a flat revolve at one turn when nothing could be measured", () => {
    // The one rule that needs no measurement: with no climb, turn two re-sweeps
    // the solid turn one made. profileHeight returning 0 must not unlock it.
    expect(clampDragAngle(3600, 0, 0)).toBe(360);
  });

  it("caps a flick that would ask for a spring nobody meant", () => {
    expect(clampDragAngle(1e6, 5, TALL)).toBe(360 * MAX_DRAG_TURNS);
    expect(clampDragAngle(-1e6, 5, TALL)).toBe(-360 * MAX_DRAG_TURNS);
  });

  it("never comes to rest on zero, which is not a revolve", () => {
    expect(clampDragAngle(0, 5, TALL)).toBe(MIN_DRAG_ANGLE);
    expect(clampDragAngle(-0.2, 5, TALL)).toBe(-MIN_DRAG_ANGLE);
    expect(clampDragAngle(NaN, 5, TALL)).toBe(MIN_DRAG_ANGLE);
  });
});

describe("arcSpanDeg", () => {
  it("spends a fixed number of pixels of arc, whatever the radius", () => {
    // 60px of arrow on a 20mm radius at 0.1mm/px: 6mm of arc.
    const deg = arcSpanDeg(20, 0.1, 60);
    expect(close((deg * Math.PI) / 180 * 20, 6, 1e-9)).toBe(true);
  });

  it("opens wider on a small radius and narrower on a large one", () => {
    expect(arcSpanDeg(4, 0.1, 60)).toBeGreaterThan(arcSpanDeg(40, 0.1, 60));
  });

  it("caps rather than wrapping the arrow round the axis", () => {
    // Past the cap the arc reads as a ring — a thing you turn to no particular
    // end — instead of as the direction the sweep is already going.
    expect(arcSpanDeg(0.2, 1, 60)).toBe(MAX_ARC_DEG);
  });

  it("falls back to the cap for a radius or a scale it cannot use", () => {
    expect(arcSpanDeg(0, 0.1, 60)).toBe(MAX_ARC_DEG);
    expect(arcSpanDeg(20, 0, 60)).toBe(MAX_ARC_DEG);
  });
});

describe("sweepArc", () => {
  it("starts exactly where the helix ends", () => {
    // The arrow is a continuation, not a widget standing nearby: a gap between
    // the two would be a gap in the claim it makes.
    const path = screwPath(AT, Z, 450, 2);
    const arc = sweepArc(AT, Z, 450, 2, 30);
    const end = path[path.length - 1]!;
    const head = arc[0]!;
    for (let i = 0; i < 3; i++) expect(close(head[i]!, end[i]!, 1e-9)).toBe(true);
  });

  it("stays on the sweep's own circle", () => {
    for (const q of sweepArc(AT, Z, 450, 2, 30)) {
      expect(close(Math.hypot(q[0], q[1]), 8, 1e-9)).toBe(true);
    }
  });

  it("climbs at the pitch, so it leaves the helix along it rather than flat", () => {
    // A quarter of a turn further on, at 2mm per turn, is half a millimetre up.
    const arc = sweepArc(AT, Z, 360, 2, 90);
    expect(close(arc[0]![2]!, 2, 1e-9)).toBe(true);
    expect(close(arc[arc.length - 1]![2]!, 2.5, 1e-9)).toBe(true);
  });

  it("points the way the caller signs it", () => {
    const fwd = sweepArc(AT, Z, 0, 0, 30);
    const back = sweepArc(AT, Z, 0, 0, -30);
    expect(Math.atan2(fwd[fwd.length - 1]![1]!, fwd[fwd.length - 1]![0]!)).toBeGreaterThan(0);
    expect(Math.atan2(back[back.length - 1]![1]!, back[back.length - 1]![0]!)).toBeLessThan(0);
  });

  it("is withheld for exactly what screwPath refuses", () => {
    // Offered and withheld together, so the tool can never draw one control for
    // a gesture the other has already said is impossible.
    expect(sweepArc([0, 0, 4], Z, 360, 1, 30)).toEqual([]);
    expect(sweepArc(AT, { origin: [0, 0, 0], dir: [0, 0, 0] }, 360, 1, 30)).toEqual([]);
  });
});
