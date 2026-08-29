// Draft used to be a guess made without looking at the part — 5° about Z, fix it
// afterwards. The two numbers that replaced the guess are these, and both are
// silent when wrong: the wrong pull axis tips the face about a line lying in
// itself (OCCT answers with the shape unchanged), and the wrong angle mapping
// makes the drag feel geared rather than reporting what a protractor would.

import { describe, it, expect } from "vitest";
import {
  MAX_DRAFT_DEG,
  alongAxis,
  draftAngle,
  draftDelta,
  draftLever,
  pullAxisFor,
} from "../../src/features/draftMath";

describe("pullAxisFor", () => {
  it("drafts a wall about the axis running UP it, not about its own normal", () => {
    // The +X face of a box: the mould opens along Y or Z, never along X.
    expect(pullAxisFor([1, 0, 0])).not.toBe("X");
    expect(pullAxisFor([0, 1, 0])).not.toBe("Y");
    expect(pullAxisFor([0, 0, 1])).not.toBe("Z");
  });

  it("picks the axis the normal is least aligned with", () => {
    // normal mostly +Z, a little +X: Y is the one it is most perpendicular to.
    expect(pullAxisFor([0.3, 0, 0.95])).toBe("Y");
    expect(pullAxisFor([0, 0.3, 0.95])).toBe("X");
    expect(pullAxisFor([0.95, 0.3, 0])).toBe("Z");
  });

  it("is stable on a face at 45 degrees rather than flipping with the mesh", () => {
    const a = pullAxisFor([Math.SQRT1_2, Math.SQRT1_2, 0]);
    const b = pullAxisFor([Math.SQRT1_2 + 1e-12, Math.SQRT1_2, 0]);
    expect(a).toBe(b);
    expect(a).toBe("Z"); // the one perpendicular to both
  });

  it("survives a degenerate normal instead of returning undefined", () => {
    expect(["X", "Y", "Z"]).toContain(pullAxisFor([0, 0, 0]));
  });
});

describe("draftLever", () => {
  it("measures the grab's height above the neutral plane, along the pull axis", () => {
    // A box from z=0 to z=20, grabbed halfway up its side.
    expect(draftLever([10, 0, 10], [0, 0, 0], "Z")).toBeCloseTo(10);
    expect(draftLever([10, 0, 10], [0, 0, -5], "Z")).toBeCloseTo(15);
  });

  it("ignores the other two axes", () => {
    expect(draftLever([99, -99, 3], [0, 0, 0], "Z")).toBeCloseTo(3);
  });

  it("is never negative — the neutral plane is a pivot, not a direction", () => {
    expect(draftLever([0, 0, -4], [0, 0, 0], "Z")).toBeCloseTo(4);
  });

  it("reads a component without a Vector3", () => {
    expect(alongAxis([1, 2, 3], "X")).toBe(1);
    expect(alongAxis([1, 2, 3], "Y")).toBe(2);
    expect(alongAxis([1, 2, 3], "Z")).toBe(3);
  });
});

describe("draftAngle", () => {
  it("reports the angle a protractor on the part would read", () => {
    // 10mm up the wall, pushed 10mm out: 45 degrees, exactly.
    expect(draftAngle(10, 10)).toBeCloseTo(45);
    // tan 30 of the lever
    expect(draftAngle(10 * Math.tan(Math.PI / 6), 10)).toBeCloseTo(30);
  });

  it("takes the sign of the drag, so a wall can undercut as well as open", () => {
    expect(draftAngle(-5, 10)).toBeCloseTo(-draftAngle(5, 10));
  });

  it("clamps rather than handing OCCT a self-intersecting wall", () => {
    expect(draftAngle(1e6, 1)).toBe(MAX_DRAFT_DEG);
    expect(draftAngle(-1e6, 1)).toBe(-MAX_DRAFT_DEG);
  });

  it("is inert where the face meets the neutral plane, instead of infinite", () => {
    expect(draftAngle(5, 0)).toBe(0);
    expect(draftAngle(5, 1e-9)).toBe(0);
  });

  it("round-trips through draftDelta, so typing and dragging agree", () => {
    for (const deg of [0.5, 3, 7.5, 30, 59]) {
      expect(draftAngle(draftDelta(deg, 12), 12)).toBeCloseTo(deg, 6);
    }
  });

  it("does not let a typed value past the clamp either", () => {
    expect(draftDelta(1000, 10)).toBeCloseTo(draftDelta(MAX_DRAFT_DEG, 10));
    expect(draftDelta(5, 0)).toBe(0);
  });
});
