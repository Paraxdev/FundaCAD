import { describe, it, expect } from "vitest";
import {
  PROFILE_DETENT,
  PROFILE_MAX,
  PROFILE_MIN,
  clampProfile,
  describeProfile,
  formatProfile,
  fractionFromProfile,
  isPlainProfile,
  profileFromFraction,
  snapProfile,
} from "../../src/features/profileArcMath";

describe("clampProfile", () => {
  it("holds the value inside the open interval the blend is defined on", () => {
    // Past these the section degenerates: weight 0 is not a legal NURBS weight
    // and an infinite one is no blend at all.
    expect(clampProfile(5)).toBe(PROFILE_MAX);
    expect(clampProfile(-5)).toBe(PROFILE_MIN);
    expect(clampProfile(0.4)).toBe(0.4);
  });

  it("treats a non-finite value as the circular fillet", () => {
    // A degenerate camera angle can hand the gizmo a NaN; writing that into the
    // feature would fail the rebuild with nothing on screen to explain it.
    expect(clampProfile(Number.NaN)).toBe(0);
    expect(clampProfile(Infinity)).toBe(0);
  });
});

describe("snapProfile", () => {
  it("lands exactly on the circular fillet inside the detent", () => {
    expect(snapProfile(0.01)).toBe(0);
    expect(snapProfile(-0.01)).toBe(0);
  });

  it("leaves a deliberate value alone", () => {
    expect(snapProfile(0.5)).toBe(0.5);
    expect(snapProfile(-0.5)).toBe(-0.5);
    expect(snapProfile(PROFILE_DETENT + 0.001)).toBeCloseTo(PROFILE_DETENT + 0.001);
  });
});

describe("isPlainProfile", () => {
  it("treats absent and zero alike", () => {
    // The feature omits the field entirely at 0, so every fillet saved before
    // profiles existed must read as plain rather than as a reweighted surface.
    expect(isPlainProfile(undefined)).toBe(true);
    expect(isPlainProfile(0)).toBe(true);
    expect(isPlainProfile(0.4)).toBe(false);
  });
});

describe("fraction <-> profile", () => {
  it("puts the circular fillet at the middle of the track", () => {
    expect(fractionFromProfile(0)).toBeCloseTo(0.5);
    expect(profileFromFraction(0.5)).toBeCloseTo(0);
  });

  it("puts the chamfer end at 0 and the sharp end at 1", () => {
    expect(fractionFromProfile(PROFILE_MIN)).toBeCloseTo(0);
    expect(fractionFromProfile(PROFILE_MAX)).toBeCloseTo(1);
  });

  it("round-trips", () => {
    for (const p of [-0.9, -0.4, 0, 0.25, 0.815]) {
      expect(profileFromFraction(fractionFromProfile(p))).toBeCloseTo(p, 6);
    }
  });

  it("holds the knob on the track however far the cursor goes", () => {
    expect(profileFromFraction(-3)).toBe(PROFILE_MIN);
    expect(profileFromFraction(4)).toBe(PROFILE_MAX);
  });

  it("is linear in the TRACK, not in the underlying weight", () => {
    // The weight runs to infinity at +1, so a weight-linear track would bunch
    // every shape anyone wants into a sliver at one end. Equal travel must mean
    // equal change in the number the user is reading.
    // Each half runs to its own limit, so the steps are even within a half.
    const up = profileFromFraction(0.7) - profileFromFraction(0.6);
    expect(profileFromFraction(0.9) - profileFromFraction(0.8)).toBeCloseTo(up, 9);
    const down = profileFromFraction(0.2) - profileFromFraction(0.1);
    expect(profileFromFraction(0.4) - profileFromFraction(0.3)).toBeCloseTo(down, 9);
    expect(profileFromFraction(0.5)).toBe(0);
  });
});

describe("formatProfile", () => {
  it("always shows the sign, because the sign is the meaning", () => {
    expect(formatProfile(0.815)).toBe("+0.815");
    expect(formatProfile(-0.815)).toBe("-0.815");
  });

  it("shows the circular fillet as a bare zero", () => {
    expect(formatProfile(0)).toBe("0");
  });
});

describe("describeProfile", () => {
  it("names the two ends and the middle", () => {
    expect(describeProfile(0)).toBe("circular");
    expect(describeProfile(0.95)).toBe("nearly sharp");
    expect(describeProfile(-0.95)).toBe("nearly a chamfer");
    expect(describeProfile(0.3)).toBe("fuller");
    expect(describeProfile(-0.3)).toBe("flatter");
  });
});
