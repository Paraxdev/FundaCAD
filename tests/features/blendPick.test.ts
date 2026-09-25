// The Fillet / Chamfer tool once it has members: a click toggles an edge or does
// nothing, it never applies the feature. MO-2: a near miss while adding the
// third of four corners used to commit the chamfer with two.

import { describe, expect, it } from "vitest";
import {
  MEMBER_PREFERENCE_PX,
  blendClickTarget,
  missPrompt,
  screenPolylineDist,
} from "../../src/features/blendPick";

const R = 13;

describe("screenPolylineDist", () => {
  it("measures along a straight edge, not only at its two ends", () => {
    // A straight B-rep edge is sampled as just its endpoints; the old member
    // hit test only looked there, so the middle of a member was unclickable.
    expect(screenPolylineDist([{ x: 0, y: 0 }, { x: 200, y: 0 }], { x: 100, y: 5 })).toBeCloseTo(5);
  });

  it("measures past an end to the end point", () => {
    expect(screenPolylineDist([{ x: 0, y: 0 }, { x: 10, y: 0 }], { x: 13, y: 4 })).toBeCloseTo(5);
  });

  it("takes the nearest segment of a curve", () => {
    const arc = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }];
    expect(screenPolylineDist(arc, { x: 15, y: 5 })).toBeCloseTo(0);
  });

  it("copes with one point and none", () => {
    expect(screenPolylineDist([{ x: 3, y: 4 }], { x: 0, y: 0 })).toBe(5);
    expect(screenPolylineDist([], { x: 0, y: 0 })).toBe(Infinity);
  });
});

describe("blendClickTarget", () => {
  it("is nothing when neither is in reach, a miss and not a commit", () => {
    expect(blendClickTarget(null, null, R)).toBe("none");
    expect(blendClickTarget(R + 1, null, R)).toBe("none");
  });

  it("adds an edge when no member is near", () => {
    expect(blendClickTarget(null, 9, R)).toBe("edge");
  });

  it("drops the member when the click is beside it, even over the preview's own edges", () => {
    // A 1mm chamfer preview puts two new edges a px or two either side of the
    // member's line.
    expect(blendClickTarget(3, 1, R)).toBe("member");
  });

  it("adds an edge running on from a member's end once the pointer is clearly on it", () => {
    expect(blendClickTarget(10, 0, R)).toBe("edge");
    expect(blendClickTarget(MEMBER_PREFERENCE_PX, 0, R)).toBe("member");
  });
});

describe("missPrompt", () => {
  it("says the members are kept and how to finish", () => {
    const p = missPrompt("chamfer", 2);
    expect(p).toContain("2 edges kept");
    expect(p).toContain("Enter");
    expect(missPrompt("fillet", 1)).toContain("1 edge kept");
  });
});
