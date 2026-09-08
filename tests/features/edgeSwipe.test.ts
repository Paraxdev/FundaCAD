// The fillet/chamfer drag measures the cursor against the EDGE.
//
// It used to measure travel along a 3D axis, which is right for press/pull and
// wrong here: a radius is a size, not a translation, so there is no world
// direction it is a distance along. The axis measurement also had a degenerate
// case, an axis leaning toward the camera has nothing left to project onto, so
// it fell back to the cursor's vertical screen position, and on a rim seen
// near edge-on the drag stopped asking how far you were from the edge and
// started asking how near the top of the window you were.
//
// These are the properties that failure violated, which is why they are the
// ones pinned: the value depends only on distance FROM THE EDGE LINE, sliding
// along the edge changes nothing, and the sign is the side the arrow points to.

import { describe, expect, it } from "vitest";
import { swipeOffsetPx } from "../../src/features/edgeSwipe";

const O = { x: 100, y: 100 };
/** An edge lying along the screen's x axis, with "out" pointing up the screen
 *  (negative y in client coordinates). */
const ALONG_X = { x: 60, y: 0 };
const UP = { x: 0, y: -40 };

describe("swipeOffsetPx", () => {
  it("is the perpendicular distance from the edge", () => {
    expect(swipeOffsetPx(O, ALONG_X, UP, { x: 100, y: 70 })).toBeCloseTo(30, 9);
  });

  it("ignores travel ALONG the edge", () => {
    // The blend runs the whole length of the edge, so sliding beside it means
    // nothing. Same distance out, 400px further along, same answer, including
    // well past the projected end of the edge, because it is the distance to
    // the LINE and an edge has no ends to fall off.
    const near = swipeOffsetPx(O, ALONG_X, UP, { x: 100, y: 70 });
    const far = swipeOffsetPx(O, ALONG_X, UP, { x: 500, y: 70 });
    expect(far).toBeCloseTo(near, 9);
  });

  it("changes sign on the far side of the edge, which is what picks the treatment", () => {
    expect(swipeOffsetPx(O, ALONG_X, UP, { x: 100, y: 130 })).toBeCloseTo(-30, 9);
  });

  it("is zero on the edge itself, the state that means no feature", () => {
    expect(swipeOffsetPx(O, ALONG_X, UP, { x: 250, y: 100 })).toBeCloseTo(0, 9);
  });

  it("takes its sign from the arrow, not from which perpendicular is 'first'", () => {
    // The same geometry with the handle pointing the other way has to report
    // the other side, or the arrow and the preview would disagree about which
    // of the two treatments the user is dragging into.
    const down = { x: 0, y: 40 };
    expect(swipeOffsetPx(O, ALONG_X, down, { x: 100, y: 70 })).toBeCloseTo(-30, 9);
  });

  it("does not care which way along itself the edge direction was measured", () => {
    const back = { x: -60, y: 0 };
    expect(swipeOffsetPx(O, back, UP, { x: 100, y: 70 })).toBeCloseTo(30, 9);
  });

  it("reads an edge seen end-on as travel along the arrow", () => {
    // The edge projects to a point, so there is no perpendicular to take. Every
    // direction genuinely leads away from it and the arrow is the only thing
    // left that tells the two treatments apart. This is the case the old axis
    // measurement answered with the cursor's height on screen.
    const dot = { x: 0.3, y: -0.2 };
    expect(swipeOffsetPx(O, dot, UP, { x: 100, y: 70 })).toBeCloseTo(30, 9);
    expect(swipeOffsetPx(O, dot, UP, { x: 100, y: 130 })).toBeCloseTo(-30, 9);
    // ...and moving ALONG the arrow is now the only thing that counts, so
    // sideways travel is ignored rather than read as distance.
    expect(swipeOffsetPx(O, dot, UP, { x: 400, y: 100 })).toBeCloseTo(0, 9);
  });

  it("survives a degenerate arrow instead of returning NaN", () => {
    // A zero-length projected arrow is reachable: the handle can point straight
    // at the camera for a frame during an orbit. Any finite answer will do; a
    // NaN would propagate into the radius and through to the kernel.
    expect(swipeOffsetPx(O, ALONG_X, { x: 0, y: 0 }, { x: 100, y: 70 })).toBeCloseTo(-30, 9);
    expect(swipeOffsetPx(O, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 70 })).toBe(0);
  });
});
