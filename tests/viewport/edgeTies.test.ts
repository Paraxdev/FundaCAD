// When a click on an edge is a question rather than an answer.

import { describe, expect, it } from "vitest";
import { TIE_BAND_PX, ambiguousCandidates } from "../../src/viewport/edgeTies";

const c = (screenDist: number, label: string) => ({ screenDist, label });

describe("ambiguousCandidates", () => {
  it("says nothing about an ordinary pick", () => {
    // The common case by a very long way, and the one that must cost nothing:
    // an empty result means "take the nearest", which is what already happened.
    expect(ambiguousCandidates([])).toEqual([]);
    expect(ambiguousCandidates([c(0.4, "Edge · Body 1")])).toEqual([]);
    expect(ambiguousCandidates([c(0.4, "Edge · Body 1"), c(40, "Edge · Body 2")])).toEqual([]);
  });

  it("offers two edges that land on the same pixels", () => {
    // The defect. Two bodies that meet each keep their own edge along the shared
    // boundary, so the two are the same distance from the cursor and the winner
    // was whichever the raycaster happened to report first.
    const out = ambiguousCandidates([c(1.2, "Edge · Body 02"), c(1.2, "Edge · Body 03")]);
    expect(out.map((x) => x.label)).toEqual(["Edge · Body 02", "Edge · Body 03"]);
  });

  it("puts the nearest first, whatever order they arrive in", () => {
    const out = ambiguousCandidates([c(2, "far"), c(0.5, "near"), c(1, "mid")]);
    expect(out.map((x) => x.label)).toEqual(["near", "mid", "far"]);
  });

  it("refuses to ask a question whose answers read alike", () => {
    // The rule that keeps this from becoming a nuisance. Two edges of one body a
    // pixel apart describe themselves identically, and a menu offering the same
    // sentence twice is worse than picking one: neither row means anything.
    expect(ambiguousCandidates([c(1, "Edge · Body 1"), c(1.1, "Edge · Body 1")])).toEqual([]);
    // ...and it is the LABEL that decides, not the geometry: add a third that
    // does say something different and the question is worth asking again.
    const out = ambiguousCandidates([
      c(1, "Edge · Body 1"), c(1.1, "Edge · Body 1"), c(1.2, "Edge · Body 2"),
    ]);
    expect(out.map((x) => x.label)).toEqual(["Edge · Body 1", "Edge · Body 2"]);
  });

  it("keeps the nearest of each label", () => {
    // So the entry the user picks is the one they were closest to among the
    // edges that call themselves that.
    const out = ambiguousCandidates([c(2, "A"), c(0.5, "A"), c(1, "B")]);
    expect(out.map((x) => [x.label, x.screenDist])).toEqual([["A", 0.5], ["B", 1]]);
  });

  it("uses the band as a distance from the NEAREST, not from the cursor", () => {
    // Both are far from the cursor and indistinguishably close to each other,
    // which is still a tie: how far the pick was off does not change whether the
    // user could have aimed between them.
    const out = ambiguousCandidates([c(9, "A"), c(9.5, "B")]);
    expect(out).toHaveLength(2);
  });

  it("drops a candidate the cursor could have chosen against", () => {
    const just = ambiguousCandidates([c(1, "A"), c(1 + TIE_BAND_PX - 0.01, "B")]);
    expect(just).toHaveLength(2);
    const past = ambiguousCandidates([c(1, "A"), c(1 + TIE_BAND_PX + 0.01, "B")]);
    expect(past).toEqual([]);
  });

  it("takes the band as an argument, so a caller may be stricter", () => {
    expect(ambiguousCandidates([c(1, "A"), c(2, "B")], 0.5)).toEqual([]);
    expect(ambiguousCandidates([c(1, "A"), c(2, "B")], 2)).toHaveLength(2);
  });

  it("survives a distance that is not a number", () => {
    // A candidate whose projection went behind the camera. Dropping it is right;
    // ranking everything after it against a NaN is not.
    const out = ambiguousCandidates([c(1, "A"), c(NaN, "B"), c(1.5, "C")]);
    expect(out.map((x) => x.label)).toEqual(["A", "C"]);
    expect(ambiguousCandidates([c(NaN, "A"), c(Infinity, "B")])).toEqual([]);
  });

  it("does not mutate what it was given", () => {
    const input = [c(3, "A"), c(1, "B")];
    ambiguousCandidates(input);
    expect(input.map((x) => x.label)).toEqual(["A", "B"]);
  });
});
