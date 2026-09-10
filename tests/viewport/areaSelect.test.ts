// Dragging a box over the model.
//
// Two things here are easy to get wrong in a way nobody notices until a part is
// wrong: which direction means which verdict, and whether a box dropped INSIDE
// one large face counts as touching it. Both have controls.

import { describe, expect, it } from "vitest";
import {
  allInsideRect,
  areaFilterIcon,
  areaFilterLabel,
  areaSelectionMode,
  AREA_FILTERS,
  boxOf,
  boxVerdict,
  convexTouchesRect,
  dragBox,
  faceInBox,
  isAreaDrag,
  nextAreaFilter,
  polylineInBox,
  pointInRect,
  unionBox,
  type AreaFilter,
  type ScreenRect,
} from "../../src/viewport/areaSelect";
import { iconPaths } from "../../src/ui/icons";

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
    // test would still say yes here, which is why the edge normals are tested.
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
    // like, every one of its triangles faces away. "Everything inside the box"
    // is vacuously true of an empty set and would have selected the whole far
    // side of the model.
    expect(faceInBox([], R, "window")).toBe(false);
    expect(faceInBox([], R, "crossing")).toBe(false);
  });
});

// ---- what the FILTER means --------------------------------------------------
//
// The filter used to narrow what the current selection mode already took, so a
// box could never reach bodies from faces mode or edges from bodies mode. Now
// it decides, which is what makes four filters worth having.

describe("the filter decides what kind of selection a box makes", () => {
  it("takes what it names, from either mode", () => {
    for (const current of ["faces", "bodies"] as const) {
      expect(areaSelectionMode("bodies", current)).toBe("bodies");
      expect(areaSelectionMode("faces", current)).toBe("faces");
      expect(areaSelectionMode("edges", current)).toBe("faces");
    }
  });

  it("leaves the mode alone for `all`", () => {
    // The one that keeps the gesture's old behaviour: "everything" means
    // everything of the kind you are already picking, so a box in bodies mode
    // does not suddenly hand back four hundred faces.
    expect(areaSelectionMode("all", "faces")).toBe("faces");
    expect(areaSelectionMode("all", "bodies")).toBe("bodies");
  });

  it("cycles through every filter and comes back", () => {
    const seen: AreaFilter[] = [];
    let f: AreaFilter = "all";
    for (let i = 0; i < AREA_FILTERS.length; i++) {
      seen.push(f);
      f = nextAreaFilter(f);
    }
    expect(new Set(seen).size).toBe(AREA_FILTERS.length);
    expect(f).toBe("all"); // back where it started
  });

  it("gives every filter a label and a mark", () => {
    // CONTROL on adding a fifth: the chip on the box renders whatever
    // areaFilterIcon returns, and an icon name with no entry draws nothing at
    // all rather than failing.
    for (const f of AREA_FILTERS) {
      expect(areaFilterLabel(f)).toBeTruthy();
      expect(iconPaths(areaFilterIcon(f))).toBeTruthy();
    }
  });
});

// ---- the shortcut that makes a live preview affordable ----------------------
//
// The box is answered every frame while it is dragged, so most of the model has
// to be ruled out without looking at a triangle. For a WINDOW the bounding box
// settles it outright, which is the claim worth pinning: "every point inside the
// rectangle" and "the bounding box inside the rectangle" are the same statement.

describe("boxVerdict", () => {
  const tri = (...pts: number[]) => pts;
  // Its own shapes rather than the ones above, which are scoped to their
  // describe: wholly in, wholly out, and one that hangs over a corner.
  const inside = tri(110, 110, 150, 120, 130, 160);
  const outside = tri(300, 300, 340, 300, 320, 340);
  const clipping = tri(190, 190, 400, 190, 400, 400);

  it("settles a window outright, both ways", () => {
    expect(boxVerdict(boxOf(tri(110, 110, 150, 120, 130, 160)), R, "window")).toBe(true);
    expect(boxVerdict(boxOf(tri(110, 110, 150, 120, 130, 260)), R, "window")).toBe(false);
  });

  it("agrees with the triangle walk it replaces, on every case above", () => {
    // THE CONTROL, and the only one that matters: the shortcut is only sound if
    // it never disagrees with the slow answer.
    const shapes = [inside, outside, clipping];
    for (const s of shapes) {
      const quick = boxVerdict(boxOf(s), R, "window");
      expect(quick).toBe(faceInBox([s], R, "window"));
      const cross = boxVerdict(boxOf(s), R, "crossing");
      if (cross !== "look") expect(cross).toBe(faceInBox([s], R, "crossing"));
    }
  });

  it("only ever rules OUT for a crossing", () => {
    // Two boxes overlapping does not mean the shapes do, so an overlap can only
    // ask for a closer look.
    expect(boxVerdict(boxOf(tri(300, 300, 340, 300, 320, 340)), R, "crossing")).toBe(false);
    expect(boxVerdict(boxOf(clipping), R, "crossing")).toBe("look");
  });

  it("refuses a window for anything behind the camera, and looks closer for a crossing", () => {
    // A null box is a shape some of which has no honest screen position.
    expect(boxOf([110, NaN, 150, 120, 130, 160])).toBeNull();
    expect(boxVerdict(null, R, "window")).toBe(false);
    expect(boxVerdict(null, R, "crossing")).toBe("look");
  });

  it("loses the extent when a union takes in something with none", () => {
    expect(unionBox([0, 0, 10, 10], [5, 5, 20, 20])).toEqual([0, 0, 20, 20]);
    expect(unionBox([0, 0, 10, 10], null)).toBeNull();
    expect(unionBox(null, [0, 0, 10, 10])).toBeNull();
  });
});
