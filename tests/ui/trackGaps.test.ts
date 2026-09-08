// The rollback marker's drop target, on both axes. The failure this guards is
// specific: read a stacked column with x coordinates and every chip's midpoint
// is the same number, so the marker always lands in gap 0 and releasing it rolls
// the model back to nothing.

import { describe, it, expect } from "vitest";
import { gapIndexIn, trackIsStacked, type TrackRect } from "../../src/ui/trackGaps";

/** n chips laid out left to right, 30px wide with a 4px gap, from x=100. */
const row = (n: number): TrackRect[] =>
  Array.from({ length: n }, (_, i) => ({ left: 100 + i * 34, top: 50, width: 30, height: 30 }));

/** The same chips stacked down the page from y=100, the right-hand history panel. */
const column = (n: number): TrackRect[] =>
  Array.from({ length: n }, (_, i) => ({ left: 50, top: 100 + i * 34, width: 200, height: 30 }));

describe("trackIsStacked", () => {
  it("tells a row from a column", () => {
    expect(trackIsStacked(row(4))).toBe(false);
    expect(trackIsStacked(column(4))).toBe(true);
  });

  it("has no opinion below two chips", () => {
    // Nothing to measure a direction from, and it costs nothing to be wrong:
    // with one chip both axes give the same two gaps.
    expect(trackIsStacked([])).toBe(false);
    expect(trackIsStacked(row(1))).toBe(false);
  });
});

describe("gapIndexIn", () => {
  it("finds the gap before, between and after chips in a row", () => {
    const r = row(3); // midpoints at 115, 149, 183
    expect(gapIndexIn(r, 0, 55)).toBe(0); // left of everything
    expect(gapIndexIn(r, 114, 55)).toBe(0); // first half of chip 0
    expect(gapIndexIn(r, 116, 55)).toBe(1); // second half → after it
    expect(gapIndexIn(r, 150, 55)).toBe(2);
    expect(gapIndexIn(r, 999, 55)).toBe(3); // past the end = roll fully forward
  });

  it("measures a COLUMN down, not across", () => {
    const c = column(3); // midpoints at y 115, 149, 183
    // Every chip shares one left edge here, so an x-based read would answer 0
    // for all of these.
    expect(gapIndexIn(c, 60, 114)).toBe(0);
    expect(gapIndexIn(c, 60, 116)).toBe(1);
    expect(gapIndexIn(c, 60, 150)).toBe(2);
    expect(gapIndexIn(c, 60, 999)).toBe(3);
  });

  it("ignores the other axis entirely", () => {
    // Dragging the marker off the side of the strip must not change which gap it
    // is over, the pointer leaves the track's bounds constantly during a drag.
    const c = column(3);
    expect(gapIndexIn(c, -500, 150)).toBe(2);
    expect(gapIndexIn(c, 5000, 150)).toBe(2);
    const r = row(3);
    expect(gapIndexIn(r, 150, -500)).toBe(2);
  });

  it("returns 0 for an empty track", () => {
    // A document with no features: the only gap there is, is the start.
    expect(gapIndexIn([], 400, 400)).toBe(0);
  });
});
