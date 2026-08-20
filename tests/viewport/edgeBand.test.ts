// The edge-vs-face band, and the two ways of getting it wrong.
//
// The band decides whether a click near a face's border selects the face or the
// edge bounding it. A fixed 3px halo made small faces unpickable; a band that
// scales without a cap would move the pick on faces that are fine today. Both
// directions are pinned here.
//
// The sampling half is not a detail. A measurement that reads a PREFIX of a
// face's triangles reports a large face as a sliver, because tessellator output
// is spatially coherent and the first N triangles are a couple of rows. That
// breaks the cap in the exact direction the cap exists to prevent, on the
// largest faces in the app.

import { describe, expect, it } from "vitest";
import {
  BAND_CAP_EXTENT_PX,
  BAND_FRACTION,
  BAND_MIN_PX,
  EDGE_NEAR_PX,
  ScreenExtent,
  edgeBandPx,
  sampleIndices,
} from "../../src/viewport/edgeBand";

describe("edgeBandPx", () => {
  it("leaves every comfortably clickable face exactly as it was", () => {
    // The safety property. At or above the cap extent the band is the same
    // constant it always was, so ordinary parts do not shift under the cursor
    // and edges keep winning wherever they win today.
    for (const px of [BAND_CAP_EXTENT_PX, 20, 87, 362, 4000]) {
      expect(edgeBandPx(px), `a ${px}px face`).toBe(EDGE_NEAR_PX);
    }
  });

  it("gives a small face an interior to click", () => {
    // The field case: a 3mm face at 60 degrees is 11 x 5 px, and a 3px halo
    // inside each of its four borders leaves nothing at all.
    const shallow = edgeBandPx(5);
    expect(shallow).toBeLessThan(EDGE_NEAR_PX);
    // Something has to survive along the short side: 5px with a band of `b`
    // leaves 5 - 2b of face.
    expect(5 - 2 * shallow).toBeGreaterThan(0);
  });

  it("decides on the SHORT side, so a sliver is treated as a sliver", () => {
    // A 22 x 11 px face is comfortably wide and still nearly unpickable, which
    // is why the measurement is the minimum dimension and not the area or the
    // diagonal.
    expect(edgeBandPx(11)).toBeLessThan(EDGE_NEAR_PX);
  });

  it("never closes the band completely", () => {
    // An edge-on face measures near zero. Its own edges still have to be
    // reachable, so the band has a floor.
    for (const px of [0, 0.0001, 1e-9]) {
      expect(edgeBandPx(px)).toBe(BAND_MIN_PX);
    }
  });

  it("falls back to the plain constant when there is nothing to measure", () => {
    // No face under the cursor, or a face whose triangles could not be read.
    // That is the behaviour everything had before the face was measured at all.
    expect(edgeBandPx(null)).toBe(EDGE_NEAR_PX);
    expect(edgeBandPx(NaN)).toBe(EDGE_NEAR_PX);
    expect(edgeBandPx(Infinity)).toBe(EDGE_NEAR_PX);
  });

  it("is monotone in the face's size", () => {
    // A face getting bigger on screen must never make its edges HARDER to hit.
    let prev = -1;
    for (let px = 0; px <= 40; px += 0.5) {
      const band = edgeBandPx(px);
      expect(band).toBeGreaterThanOrEqual(prev);
      prev = band;
    }
  });

  it("caps exactly where the constant takes over", () => {
    expect(BAND_CAP_EXTENT_PX * BAND_FRACTION).toBeCloseTo(EDGE_NEAR_PX, 12);
  });
});

describe("sampleIndices", () => {
  it("spreads across the whole range rather than taking a prefix", () => {
    // The bug this replaced: reading the first 256 triangles of a 50,000
    // triangle face measures two rows of it. The last sample has to be near the
    // end, or the far side of the face is never seen.
    const idx = sampleIndices(50_000, 256);
    expect(idx).toHaveLength(256);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]!).toBeGreaterThan(49_000);
  });

  it("returns every item when there are fewer than the budget", () => {
    expect(sampleIndices(3, 256)).toEqual([0, 1, 2]);
  });

  it("is strictly increasing and in range", () => {
    const idx = sampleIndices(1000, 64);
    for (let i = 1; i < idx.length; i++) expect(idx[i]!).toBeGreaterThan(idx[i - 1]!);
    for (const i of idx) expect(i).toBeGreaterThanOrEqual(0);
    for (const i of idx) expect(i).toBeLessThan(1000);
  });

  it("copes with nothing to sample", () => {
    expect(sampleIndices(0, 256)).toEqual([]);
    expect(sampleIndices(10, 0)).toEqual([]);
  });
});

describe("ScreenExtent", () => {
  it("reports the smaller side", () => {
    const b = new ScreenExtent();
    b.add(10, 10);
    b.add(32, 21);
    expect(b.min).toBe(11); // 22 wide, 11 tall
  });

  it("reads as unmeasurable until something is added", () => {
    const b = new ScreenExtent();
    expect(b.measured).toBe(false);
    // Infinity rather than 0, so a caller polling for an early exit does not
    // exit on an empty box and report a face it never looked at.
    expect(b.min).toBe(Infinity);
  });

  it("ignores points that are not finite", () => {
    // A vertex behind the camera projects to a non-finite coordinate; letting
    // one in would collapse the box and make every face read as a sliver.
    const b = new ScreenExtent();
    b.add(10, 10);
    b.add(NaN, 5);
    b.add(Infinity, Infinity);
    b.add(32, 21);
    expect(b.min).toBe(11);
  });

  it("grows a prefix-shaped sample into the whole face", () => {
    // A row of a tessellated face: wide and one triangle tall. Reading only
    // that reports a sliver; adding the rest of the face corrects it. This is
    // the shape of the prefix-vs-sample bug, in the box that measures it.
    const row = new ScreenExtent();
    for (let x = 0; x < 360; x += 4) row.add(x, 0), row.add(x, 9);
    expect(row.min).toBe(9);

    const whole = new ScreenExtent();
    for (let x = 0; x < 360; x += 4) for (let y = 0; y < 360; y += 4) whole.add(x, y);
    expect(whole.min).toBe(356);
    expect(edgeBandPx(row.min)).toBeLessThan(EDGE_NEAR_PX); // wrongly shrunk
    expect(edgeBandPx(whole.min)).toBe(EDGE_NEAR_PX); // correctly capped
  });
});
