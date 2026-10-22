import { afterEach, describe, expect, it } from "vitest";
import { aboutFactor, deflectionNote, SAFE_MARGIN, verdictView } from "../../src/ui/stressVerdict";
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
    expect(verdictView({ safetyFactor: 3.32 }).headline).toContain("about 3.3x safe");
    expect(verdictView({ safetyFactor: 1.499 }).headline).toContain("about 1.4x");
    expect(verdictView({ safetyFactor: 1.499 }).headline).toContain("1.5x");
    expect(verdictView({ safetyFactor: 0.999 }).detail).toContain("about 1.1x");
    expect(verdictView({ safetyFactor: 0.62 }).detail).toContain("about 1.7x");
    expect(verdictView({ safetyFactor: 250 }).headline).toContain("more than 100x");
    expect(verdictView({ safetyFactor: null }).detail).toBeNull();
  });

  it("names the marked spot whether it holds or fails", () => {
    expect(
      [3.32, 1.2, 0.62].map((sf) => /marked spot/.test(JSON.stringify(verdictView({ safetyFactor: sf })))),
    ).toEqual([true, true, true]);
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
