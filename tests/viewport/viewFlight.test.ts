// The two decisions behind entering a sketch: how long the camera takes to get
// there, and which side of the plane it arrives on.
import { describe, expect, it } from "vitest";
import {
  ease,
  flightSeconds,
  MAX_FLIGHT_S,
  MIN_FLIGHT_S,
  SNAP_TURN_RAD,
  viewSideNormal,
  worthFlying,
  type Vec3,
} from "../../src/viewport/viewFlight";

describe("flightSeconds", () => {
  it("takes longer for a bigger turn", () => {
    expect(flightSeconds(Math.PI, 1)).toBeGreaterThan(flightSeconds(0.2, 1));
  });

  it("stays inside the bounds however extreme the move", () => {
    for (const [turn, ratio] of [[0, 1], [Math.PI, 1000], [Math.PI, 1e-6], [4, 8]] as const) {
      const s = flightSeconds(turn, ratio);
      expect(s).toBeGreaterThanOrEqual(MIN_FLIGHT_S);
      expect(s).toBeLessThanOrEqual(MAX_FLIGHT_S);
    }
  });

  it("charges the same for zooming out 4x as for zooming in 4x", () => {
    expect(flightSeconds(0, 4)).toBeCloseTo(flightSeconds(0, 0.25), 12);
  });

  it("spends time on a pure dolly, with no turn at all", () => {
    // Entering a sketch on a face you are already square to still pulls the
    // camera to the standoff distance, and that move IS the animation.
    expect(flightSeconds(0, 6)).toBeGreaterThan(flightSeconds(0, 1));
  });

  it("survives rubbish", () => {
    expect(flightSeconds(NaN, NaN)).toBe(MIN_FLIGHT_S);
    expect(flightSeconds(0, 0)).toBe(MIN_FLIGHT_S);
    expect(flightSeconds(0, -3)).toBe(MIN_FLIGHT_S);
  });
});

describe("worthFlying", () => {
  it("snaps a move that is already there", () => {
    expect(worthFlying(SNAP_TURN_RAD / 2, 1)).toBe(false);
  });

  it("flies a real turn", () => {
    expect(worthFlying(0.6, 1)).toBe(true);
  });

  it("flies a pure zoom with no turn", () => {
    expect(worthFlying(0, 2)).toBe(true);
  });

  it("refuses to fly on rubbish rather than animating toward NaN", () => {
    expect(worthFlying(NaN, 1)).toBe(false);
    expect(worthFlying(1, 0)).toBe(false);
  });
});

describe("ease", () => {
  it("pins both ends", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
  });

  it("clamps outside [0,1] rather than overshooting", () => {
    expect(ease(-4)).toBe(0);
    expect(ease(9)).toBe(1);
  });

  it("is halfway at halfway, and symmetric about it", () => {
    expect(ease(0.5)).toBeCloseTo(0.5, 12);
    for (const t of [0.1, 0.25, 0.4]) {
      expect(ease(t) + ease(1 - t)).toBeCloseTo(1, 12);
    }
  });

  it("starts and ends slowly — the point of easing", () => {
    // The first tenth of the trip covers far less than a tenth of the distance,
    // and the middle tenth covers far more. A linear ramp would fail this.
    expect(ease(0.1)).toBeLessThan(0.02);
    expect(ease(0.55) - ease(0.45)).toBeGreaterThan(0.15);
  });

  it("never goes backwards", () => {
    let last = -1;
    for (let i = 0; i <= 100; i++) {
      const v = ease(i / 100);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
});

describe("viewSideNormal", () => {
  const up: Vec3 = [0, 0, 1];
  const origin: Vec3 = [0, 0, 0];

  it("keeps the normal when the camera is already on that side", () => {
    expect(viewSideNormal(up, [0, 0, 50], origin)).toEqual([0, 0, 1]);
  });

  it("flips it when the camera is underneath — the whole point", () => {
    // Starting a sketch on the base XY plane from below used to fling the view
    // through the part to look at it from above.
    expect(viewSideNormal(up, [0, 0, -50], origin)).toEqual([0, 0, -1]);
  });

  it("measures against the plane's ORIGIN, not the world's", () => {
    // A plane 100 above the origin with the eye at z=50 is a view from BELOW it.
    expect(viewSideNormal(up, [0, 0, 50], [0, 0, 100])).toEqual([0, 0, -1]);
  });

  it("keeps the given normal on a grazing view, where the side is a coin flip", () => {
    // A coin flip is the one thing this must not be: the answer decides which
    // way the sketch reads on screen.
    expect(viewSideNormal(up, [100, 0, 0], origin, 1e-3)).toEqual(up);
  });

  it("normalises before deciding, so an unnormalised normal still flips", () => {
    expect(viewSideNormal([0, 0, 7], [0, 0, -50], origin)).toEqual([0, 0, -7]);
  });

  it("gives up rather than returning NaN when there is nothing to measure", () => {
    expect(viewSideNormal([0, 0, 0], [0, 0, 5], origin)).toEqual([0, 0, 0]);
    expect(viewSideNormal(up, origin, origin)).toEqual(up); // eye AT the origin
  });

  it("agrees with the sign of the dot product on oblique views", () => {
    const n: Vec3 = [0.6, 0, 0.8];
    const front = viewSideNormal(n, [30, 10, 40], origin);
    const back = viewSideNormal(n, [-30, 10, -40], origin);
    expect(front).toEqual(n);
    expect(back[0]).toBeCloseTo(-0.6, 12);
    expect(back[2]).toBeCloseTo(-0.8, 12);
  });
});
