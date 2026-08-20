// The over-drawn line that makes one edge unmistakable.
//
// The class itself needs a WebGL-free three.js, which it has, but what is worth
// pinning is the flattening: an off-by-one here draws an edge that is subtly not
// the edge, which is the one thing an emphasis must never do.

import { describe, expect, it } from "vitest";
import { segmentPositions } from "../../src/viewport/edgeEmphasis";

describe("segmentPositions", () => {
  it("turns a polyline into consecutive segment pairs", () => {
    // Three points are two segments, and the middle point appears twice: once
    // as the first segment's end, once as the second's start.
    expect([...segmentPositions([[0, 0, 0], [1, 2, 3], [4, 5, 6]])]).toEqual([
      0, 0, 0, 1, 2, 3,
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("gives a single segment for two points", () => {
    expect([...segmentPositions([[1, 1, 1], [2, 2, 2]])]).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it("has no segments for a polyline that is not one", () => {
    expect(segmentPositions([])).toHaveLength(0);
    expect(segmentPositions([[0, 0, 0]])).toHaveLength(0);
  });

  it("is exactly six floats per segment", () => {
    for (const n of [2, 3, 8, 40]) {
      const pts = Array.from({ length: n }, (_, i) => [i, i, i]);
      expect(segmentPositions(pts)).toHaveLength((n - 1) * 6);
    }
  });

  it("fills a missing coordinate with zero rather than NaN", () => {
    // A malformed point would otherwise put NaN in a vertex buffer, and a NaN
    // vertex takes the whole draw call with it rather than one segment.
    const out = segmentPositions([[1, 2], [3, 4, 5]] as unknown as number[][]);
    expect([...out]).toEqual([1, 2, 0, 3, 4, 5]);
  });
});
