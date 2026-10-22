import { afterEach, describe, expect, it } from "vitest";
import {
  aboutFactor,
  deflectionNote,
  peakPlaceOf,
  SAFE_MARGIN,
  verdictView,
  weakSpotLabel,
} from "../../src/ui/stressVerdict";
import { setUnit } from "../../src/ui/units";

afterEach(() => setUnit("mm"));

const level = (sf: number | null) => verdictView({ safetyFactor: sf }).level;

describe("verdictView", () => {
  it("holds from the margin up, marginal from 1 to just under it, fails below 1, none without a factor", () => {
    expect([3.32, 1.5, 1.499, 1.0, 0.999, 0.62, 250, null].map(level)).toEqual([
      "holds",
      "holds",
      "marginal",
      "marginal",
      "fails",
      "fails",
      "holds",
      "none",
    ]);
    expect(SAFE_MARGIN).toBe(1.5);
  });

  it("states the safe factor rounded down and the overload rounded up", () => {
    expect(verdictView({ safetyFactor: 3.32 }).headline).toBe("Holds, about 3.3x safe.");
    expect(verdictView({ safetyFactor: 1.499 }).headline).toBe("Holds, but only about 1.4x safe, keep about 1.5x.");
    expect(verdictView({ safetyFactor: 250 }).headline).toBe("Holds, more than 100x safe.");
    expect(verdictView({ safetyFactor: null }).detail).toBeNull();
  });

  it("says an overload under 2x in percent, rounded up, and a larger one as a factor", () => {
    const detail = (sf: number) => verdictView({ safetyFactor: sf }).detail;
    expect([0.978, 0.9999, 0.62, 0.5001, 0.5, 0.31, 0.0101].map(detail)).toEqual([
      "The load is about 3% more than it can take.",
      "The load is about 1% more than it can take.",
      "The load is about 62% more than it can take.",
      "The load is about 100% more than it can take.",
      "The load is about 2x what it can take.",
      "The load is about 3.3x what it can take.",
      "The load is about 100x what it can take.",
    ]);
  });

  it("says more than 100x for a factor under 0.01, zero included", () => {
    expect([0.005, 0].map((sf) => verdictView({ safetyFactor: sf }).detail)).toEqual([
      "The load is more than 100x what it can take.",
      "The load is more than 100x what it can take.",
    ]);
  });

  it("names the marked spot only while it is marked", () => {
    const at = (sf: number, marked: boolean) => verdictView({ safetyFactor: sf }, SAFE_MARGIN, marked);
    expect([3.32, 1.2, 0.62].map((sf) => at(sf, true))).toEqual([
      { level: "holds", headline: "Holds, about 3.3x safe.", detail: "Weakest at the marked spot." },
      {
        level: "marginal",
        headline: "Holds, but only about 1.2x safe, keep about 1.5x.",
        detail: "Weakest at the marked spot.",
      },
      {
        level: "fails",
        headline: "Likely to fail at the marked spot.",
        detail: "The load is about 62% more than it can take.",
      },
    ]);
    expect([3.32, 1.2, 0.62].map((sf) => at(sf, false))).toEqual([
      { level: "holds", headline: "Holds, about 3.3x safe.", detail: null },
      { level: "marginal", headline: "Holds, but only about 1.2x safe, keep about 1.5x.", detail: null },
      { level: "fails", headline: "Likely to fail.", detail: "The load is about 62% more than it can take." },
    ]);
  });

  it("reads as rough when the peak is at a sharp inside corner or the edge of a support", () => {
    const v = (sf: number, peakPlace: "corner" | "support", marked = true) =>
      verdictView({ safetyFactor: sf, peakPlace }, SAFE_MARGIN, marked);
    expect(v(2.94, "corner")).toEqual({
      level: "holds",
      headline: "Holds by a rough reading, about 2.9x safe.",
      detail:
        "Weakest at the marked sharp corner. The number at a sharp corner is rough, and rounding the corner makes it stronger.",
    });
    expect(v(1.3, "support", false)).toEqual({
      level: "marginal",
      headline: "Holds by a rough reading, but only about 1.3x safe, keep about 1.5x.",
      detail: "Weakest at the edge of a support. The number there is rough, so read the colour a little away from it.",
    });
    expect(v(0.8, "corner", false)).toEqual({
      level: "fails",
      headline: "Likely to fail at a sharp inside corner, by a rough reading.",
      detail:
        "The load is about 25% more than it can take. The number at a sharp corner is rough, and rounding the corner makes it stronger.",
    });
    expect(v(0.8, "support").headline).toBe("Likely to fail at the marked edge of a support, by a rough reading.");
  });

  it("takes another margin when given one", () => {
    expect([verdictView({ safetyFactor: 1.8 }, 2).level, verdictView({ safetyFactor: 2 }, 2).level]).toEqual([
      "marginal",
      "holds",
    ]);
  });
});

describe("aboutFactor", () => {
  it("rounds to two figures, down or up, and caps above 100", () => {
    expect([9.99, 10, 99.9, 100, 100.5].map((x) => aboutFactor(x, "down"))).toEqual([
      "9.9",
      "10",
      "99",
      "100",
      "more than 100",
    ]);
    expect([9.99, 10, 99.9, 100, 1.001].map((x) => aboutFactor(x, "up"))).toEqual(["10", "10", "100", "100", "1.1"]);
  });
});

describe("peakPlaceOf", () => {
  const tail =
    ", stress at a sharp inside corner or where a support ends grows as the mesh is refined, look at the colour away from it";
  it("reads the corner and the support edge from the engine's warning, and nothing from any other", () => {
    const other = "the elements (2.000 mm) are larger than half the part's typical thickness";
    expect([
      peakPlaceOf([]),
      peakPlaceOf([other]),
      peakPlaceOf([other, `the peak stress is at a sharp inside corner${tail}`]),
      peakPlaceOf([`the peak stress is where a pinned face ends${tail}`]),
      peakPlaceOf([`the peak stress is where a fixed spot ends${tail}`]),
      peakPlaceOf([`a note that the peak stress is at a sharp inside corner${tail}`]),
    ]).toEqual([null, null, "corner", "support", "support", null]);
  });
});

describe("weakSpotLabel", () => {
  it("gives the safe factor rounded down, or the overload as the verdict words it", () => {
    expect([3.32, 1, 0.978, 0.31, 0.004, null, Infinity].map(weakSpotLabel)).toEqual([
      "Weakest, 3.3x safe",
      "Weakest, 1x safe",
      "Weakest, 3% over",
      "Weakest, 3.3x over",
      "Weakest, more than 100x over",
      "Weakest",
      "Weakest",
    ]);
  });
});

describe("deflectionNote", () => {
  it("says how far it bends and how large it is drawn", () => {
    expect(deflectionNote(0.47, "mm", 0)).toBe("Bends at most 0.47 mm, not drawn.");
    expect(deflectionNote(0.47, "mm", 1)).toBe("Bends at most 0.47 mm, drawn at true size.");
    expect(deflectionNote(0.47, "mm", 10.5)).toContain("drawn 11x larger");
    expect(deflectionNote(null, "mm", 10)).toBeNull();
    setUnit("in");
    expect(deflectionNote(2.54, "in", 1)).toContain("0.1 in");
  });
});
