import { describe, it, expect } from "vitest";
import { handlePlacement } from "../../src/features/edgeNudge";

type Vec3 = [number, number, number];

// A straight edge is tessellated as just its two endpoints, which is exactly
// the case that has bitten edge selectors before (see edgeMatch.ts).
const straight: Vec3[] = [
  [0, 0, 0],
  [10, 0, 0],
];

describe("handlePlacement", () => {
  it("stands the handle on the edge's midpoint", () => {
    expect(handlePlacement([straight])?.anchor).toEqual([5, 0, 0]);
  });

  it("uses the ARC-LENGTH midpoint, not the middle sample", () => {
    // The whole reason polylineMid exists: an unevenly sampled polyline's
    // middle SAMPLE is nowhere near its middle. If the handle used the sample
    // it would sit somewhere other than where EdgeFeatureTool anchors, and
    // would visibly jump the instant the tool took over the gesture.
    const uneven: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [10, 0, 0],
    ];
    expect(handlePlacement([uneven])?.anchor).toEqual([5, 0, 0]);
  });

  it("lies across the edge", () => {
    expect(handlePlacement([straight])?.tangent).toEqual([1, 0, 0]);
  });

  it("averages the midpoints of a multi-edge selection", () => {
    const other: Vec3[] = [
      [0, 4, 0],
      [10, 4, 0],
    ];
    expect(handlePlacement([straight, other])?.anchor).toEqual([5, 2, 0]);
  });

  it("takes the first edge's tangent for a multi-edge selection", () => {
    // There is no single right perpendicular for several edges; one that lies
    // across a real member beats the camera-right fallback.
    const acrossY: Vec3[] = [
      [0, 0, 0],
      [0, 6, 0],
    ];
    expect(handlePlacement([straight, acrossY])?.tangent).toEqual([1, 0, 0]);
    expect(handlePlacement([acrossY, straight])?.tangent).toEqual([0, 1, 0]);
  });

  it("returns a unit tangent whatever the edge's length", () => {
    const long: Vec3[] = [
      [0, 0, 0],
      [0, 0, 900],
    ];
    expect(handlePlacement([long])?.tangent).toEqual([0, 0, 1]);
  });

  it("reports no tangent for a closed edge and lets the caller fall back", () => {
    // A full circle's first and last samples coincide, so it has no chord. The
    // handle still has somewhere to stand, it just needs the camera's right
    // vector for direction, which this module has no way to know.
    const circle: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
      [1, 0, 0],
    ];
    const place = handlePlacement([circle]);
    expect(place).not.toBeNull();
    expect(place?.tangent).toBeNull();
  });

  it("borrows a tangent from a later edge when the first has none", () => {
    const degenerate: Vec3[] = [
      [3, 3, 3],
      [3, 3, 3],
    ];
    expect(handlePlacement([degenerate, straight])?.tangent).toEqual([1, 0, 0]);
  });

  it("has nothing to offer for an empty selection", () => {
    // The hide path. Selecting a face, or clearing with Esc, lands here.
    expect(handlePlacement([])).toBeNull();
  });

  it("survives an edge with no points rather than anchoring at the origin", () => {
    // A NaN or [0,0,0] anchor would park the handle in the middle of the world
    // with no visible cause.
    expect(handlePlacement([[]])).toBeNull();
    expect(handlePlacement([[], straight])?.anchor).toEqual([5, 0, 0]);
  });
});
