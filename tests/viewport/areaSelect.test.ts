// Dragging a box over the model.
//
// Two things here are easy to get wrong in a way nobody notices until a part is
// wrong: which direction means which verdict, and whether a box dropped INSIDE
// one large face counts as touching it. Both have controls.

import { describe, expect, it } from "vitest";
import {
  allInsideRect,
  convexTouchesRect,
  dragBox,
  faceInBox,
  isAreaDrag,
  polylineInBox,
  pointInRect,
  type ScreenRect,
} from "../../src/viewport/areaSelect";

const rect = (x0: number, y0: number, x1: number, y1: number): ScreenRect => ({ x0, y0, x1, y1 });
const R = rect(100, 100, 200, 200);

describe("dragBox", () => {
  it("reads the horizontal direction, and only that", () => {
    expect(dragBox(50, 50, 150, 150).mode).toBe("window");
    expect(dragBox(150, 150, 50, 50).mode).toBe("crossing");
    // Vertical direction says nothing: dragging right-and-up and right-and-down
    // are the same gesture. Giving four meanings to a two-meaning gesture is how
    // a user ends up with a selection they cannot explain.
    expect(dragBox(50, 150, 150, 50).mode).toBe("window");
    expect(dragBox(150, 50, 50, 150).mode).toBe("crossing");
  });

  it("normalises the rectangle whichever way it was drawn", () => {
    expect(dragBox(150, 170, 50, 30).rect).toEqual(rect(50, 30, 150, 170));
    expect(dragBox(50, 30, 150, 170).rect).toEqual(rect(50, 30, 150, 170));
  });

  it("calls a dead-vertical drag a window", () => {
    // Neither direction. The stricter verdict is the one that cannot hand back
    // geometry nobody asked for.
    expect(dragBox(100, 20, 100, 300).mode).toBe("window");
  });

  it("is not a box until the pointer has actually gone somewhere", () => {
    expect(isAreaDrag(10, 10, 12, 12)).toBe(false); // a click that wobbled
    expect(isAreaDrag(10, 10, 10, 14)).toBe(true);
  });
});

describe("pointInRect / allInsideRect", () => {
  it("counts the boundary as inside", () => {
    expect(pointInRect(100, 100, R)).toBe(true);
    expect(pointInRect(200, 200, R)).toBe(true);
    expect(pointInRect(99.9, 150, R)).toBe(false);
  });

  it("refuses a coordinate that is not a number", () => {
    // A vertex behind a perspective camera projects to nonsense. Nonsense that
    // happened to land in the box would select a face nobody can see, so it is
    // read as "not in the box" rather than skipped.
    expect(pointInRect(NaN, 150, R)).toBe(false);
    expect(pointInRect(150, Infinity, R)).toBe(false);
    expect(allInsideRect([150, 150, NaN, 150], R)).toBe(false);
  });

  it("has nothing to say about an empty shape", () => {
    expect(allInsideRect([], R)).toBe(false);
  });
});

describe("convexTouchesRect", () => {
  it("catches a box dropped INSIDE one enormous triangle", () => {
    // THE case a vertex test gets wrong, and the one a user hits constantly:
    // dragging a small crossing box in the middle of a plate's top face. No
    // corner of the triangle is in the box and no edge of it crosses the box.
    const huge = [-5000, -5000, 5000, -5000, 0, 5000];
    expect(convexTouchesRect(huge, R)).toBe(true);
    // CONTROL: the same triangle moved off to one side must NOT be taken.
    const away = [-5000, -5000, -4000, -5000, -4500, -4000];
    expect(convexTouchesRect(away, R)).toBe(false);
  });

  it("catches a triangle that only clips a corner", () => {
    const clip = [190, 190, 400, 190, 400, 400];
    expect(convexTouchesRect(clip, R)).toBe(true);
    // CONTROL: nudged past the corner it stops touching, and a bounding-box
    // test would still say yes here — which is why the edge normals are tested.
    const missed = [210, 210, 400, 210, 400, 400];
    expect(convexTouchesRect(missed, R)).toBe(false);
  });

  it("works on a bare segment", () => {
    expect(convexTouchesRect([0, 150, 400, 150], R)).toBe(true); // straight through
    expect(convexTouchesRect([0, 50, 400, 50], R)).toBe(false); // above it
    // a diagonal that passes the rect's x span and its y span but misses it
    expect(convexTouchesRect([0, 300, 300, 0], R)).toBe(true);
    expect(convexTouchesRect([0, 500, 500, 0], R)).toBe(false);
  });

  it("refuses a shape carrying a non-finite point", () => {
    expect(convexTouchesRect([150, 150, NaN, 150, 160, 160], R)).toBe(false);
  });
});

describe("polylineInBox", () => {
  const through = [0, 150, 400, 150]; // crosses the rect, no sample inside
  const inside = [120, 120, 150, 150, 180, 180];

  it("takes a curve that only passes through, when crossing", () => {
    expect(polylineInBox(through, R, "crossing")).toBe(true);
    // CONTROL: a window must not, because none of it is inside the box.
    expect(polylineInBox(through, R, "window")).toBe(false);
  });

  it("takes a curve wholly inside, either way", () => {
    expect(polylineInBox(inside, R, "window")).toBe(true);
    expect(polylineInBox(inside, R, "crossing")).toBe(true);
  });

  it("leaves a curve that runs off the edge out of a window", () => {
    const half = [150, 150, 400, 150];
    expect(polylineInBox(half, R, "window")).toBe(false);
    expect(polylineInBox(half, R, "crossing")).toBe(true);
  });
});

describe("faceInBox", () => {
  const inside = [110, 110, 190, 110, 150, 190];
  const outside = [300, 300, 380, 300, 340, 380];
  const clipping = [190, 190, 400, 190, 400, 400];

  it("gives a window every triangle or nothing", () => {
    expect(faceInBox([inside], R, "window")).toBe(true);
    expect(faceInBox([inside, outside], R, "window")).toBe(false);
    // CONTROL: crossing takes the same pair, because one of them is in there.
    expect(faceInBox([inside, outside], R, "crossing")).toBe(true);
  });

  it("stops at the first hit when crossing", () => {
    // Not directly observable, so it is measured: the iterable is consumed
    // lazily and the count says how far it got. A crossing box over a large
    // import walks the whole face otherwise.
    let seen = 0;
    function* tris() {
      for (const t of [clipping, outside, outside, outside]) { seen++; yield t; }
    }
    expect(faceInBox(tris(), R, "crossing")).toBe(true);
    expect(seen).toBe(1);
  });

  it("takes nothing for a face with no triangles left", () => {
    // What a face reduced to nothing by the caller's visibility filter looks
    // like — every one of its triangles faces away. "Everything inside the box"
    // is vacuously true of an empty set and would have selected the whole far
    // side of the model.
    expect(faceInBox([], R, "window")).toBe(false);
    expect(faceInBox([], R, "crossing")).toBe(false);
  });
});
