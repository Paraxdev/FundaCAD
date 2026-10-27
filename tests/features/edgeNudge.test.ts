import { describe, it, expect } from "vitest";
import { handlePlacement, pointOnEdge } from "../../src/features/edgeNudge";

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

  // The mean of several midpoints used to stand the handle in mid air, over the
  // middle of a box's top face rather than on any of its edges.
  it("stands on the most recently picked of several edges, not their average", () => {
    const other: Vec3[] = [
      [0, 4, 0],
      [10, 4, 0],
    ];
    expect(handlePlacement([straight, other])?.anchor).toEqual([5, 4, 0]);
    expect(handlePlacement([other, straight])?.anchor).toEqual([5, 0, 0]);
  });

  it("lies across the most recently picked edge", () => {
    const acrossY: Vec3[] = [
      [0, 0, 0],
      [0, 6, 0],
    ];
    expect(handlePlacement([straight, acrossY])?.tangent).toEqual([0, 1, 0]);
    expect(handlePlacement([acrossY, straight])?.tangent).toEqual([1, 0, 0]);
  });

  it("returns a unit tangent whatever the edge's length", () => {
    const long: Vec3[] = [
      [0, 0, 0],
      [0, 0, 900],
    ];
    expect(handlePlacement([long])?.tangent).toEqual([0, 0, 1]);
  });

  it("lies across a closed edge where it stands, though the edge has no chord", () => {
    const circle: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
      [1, 0, 0],
    ];
    const place = handlePlacement([circle]);
    expect(place?.anchor).toEqual([-1, 0, 0]);
    expect(place?.tangent?.map((c) => Math.round(c * 1e6) / 1e6 + 0)).toEqual([-0.707107, -0.707107, 0]);
  });

  it("passes over a last edge with no length for the one picked before it", () => {
    const degenerate: Vec3[] = [
      [3, 3, 3],
      [3, 3, 3],
    ];
    expect(handlePlacement([straight, degenerate])).toEqual({ anchor: [5, 0, 0], tangent: [1, 0, 0] });
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

describe("pointOnEdge", () => {
  it("stands on the edge where it was clicked, not mid-edge", () => {
    const line: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
    ];
    expect(pointOnEdge(line, [8, 1, 0])).toEqual({ anchor: [8, 0, 0], tangent: [1, 0, 0] });
  });
  it("clamps past the ends", () => {
    const line: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
    ];
    expect(pointOnEdge(line, [-4, 0, 0])?.anchor).toEqual([0, 0, 0]);
  });
  it("takes the local direction on a curve", () => {
    const bend: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ];
    expect(pointOnEdge(bend, [10.5, 7, 0])).toEqual({ anchor: [10, 7, 0], tangent: [0, 1, 0] });
  });
  it("has nothing to stand on without a segment", () => {
    expect(pointOnEdge([[1, 1, 1]], [0, 0, 0])).toBeNull();
  });
});
