// A tangent (smooth) edge, a fillet's border, must not take a click meant for
// the faces either side of it or for a sharp edge beside it, and must still be
// reachable when the pointer is right on it or nothing else is near.

import { describe, expect, it } from "vitest";
import {
  EDGE_NEAR_PX,
  EDGE_SHORT_BOOST_PX,
  SMOOTH_EDGE_BAND_PX,
  SMOOTH_EDGE_PENALTY_PX,
  edgeBandForPx,
  edgeRankPx,
  preferredEdge,
} from "../../src/viewport/edgeBand";

const cand = (screenDist: number, smooth: boolean, occluded = false, shortBoost = 0) => ({
  screenDist,
  rankPx: edgeRankPx(screenDist, smooth),
  occluded,
  bandPx: edgeBandForPx(EDGE_NEAR_PX, shortBoost, smooth),
});
const ranked = <T extends { rankPx: number }>(cs: T[]) => [...cs].sort((a, b) => a.rankPx - b.rankPx);

describe("edgeRankPx", () => {
  it("leaves a sharp edge at its distance", () => {
    expect(edgeRankPx(4, false)).toBe(4);
  });

  it("puts a smooth edge behind a sharp one that is nearly as close", () => {
    // The cup rim: the sharp inner edge sits a few px from the fillet's border.
    const order = ranked([cand(1, true), cand(5, false)]);
    expect(order[0]!.screenDist).toBe(5);
    expect(edgeRankPx(1, true)).toBe(1 + SMOOTH_EDGE_PENALTY_PX);
  });

  it("still lets a smooth edge ahead of a sharp one far enough away", () => {
    const order = ranked([cand(0.5, true), cand(0.5 + SMOOTH_EDGE_PENALTY_PX + 1, false)]);
    expect(order[0]!.rankPx).toBe(0.5 + SMOOTH_EDGE_PENALTY_PX);
  });
});

describe("edgeBandForPx", () => {
  it("keeps a sharp edge's band and its short-edge boost", () => {
    expect(edgeBandForPx(EDGE_NEAR_PX, 2, false)).toBe(EDGE_NEAR_PX + 2);
  });

  it("all but closes the band for a smooth edge, boost or not", () => {
    expect(edgeBandForPx(EDGE_NEAR_PX, EDGE_SHORT_BOOST_PX, true)).toBe(SMOOTH_EDGE_BAND_PX);
  });

  it("never widens a band that a small face already narrowed", () => {
    expect(edgeBandForPx(0.75, 0, true)).toBe(0.75);
  });
});

describe("preferredEdge", () => {
  it("gives the face a click 2px off a smooth edge", () => {
    expect(preferredEdge([cand(2, true)], true)).toBeNull();
  });

  it("gives the smooth edge a click on its drawn line", () => {
    expect(preferredEdge([cand(0.6, true)], true)).toBe(0);
  });

  it("gives the smooth edge a click with no face under the pointer", () => {
    // A fillet's border on the silhouette, picked against empty space.
    expect(preferredEdge([cand(6, true)], false)).toBe(0);
  });

  it("keeps a sharp edge's full band", () => {
    expect(preferredEdge([cand(2.5, false)], true)).toBe(0);
    expect(preferredEdge([cand(3.5, false)], true)).toBeNull();
  });

  it("reaches the sharp edge behind a smooth one that ranked first but is off its line", () => {
    const cs = ranked([cand(2, false), cand(0.2, true)]);
    expect(cs[preferredEdge(cs, true)!]!.screenDist).toBe(2);
  });

  it("reaches the smooth edge when the pointer is on it and the sharp one is outside its band", () => {
    const cs = ranked([cand(5, false), cand(0.4, true)]);
    expect(cs[preferredEdge(cs, true)!]!.screenDist).toBe(0.4);
  });

  it("skips an edge round the back of the body for a visible one", () => {
    const cs = [cand(0.5, false, true), cand(1.5, false)];
    expect(preferredEdge(cs, true)).toBe(1);
  });

  it("gives the face when every candidate is out of reach", () => {
    expect(preferredEdge([], true)).toBeNull();
    expect(preferredEdge([cand(0.5, false, true)], true)).toBeNull();
  });
});
