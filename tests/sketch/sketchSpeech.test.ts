import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { coordWords, pointSentence, snapWords } from "../../src/sketch/sketchSpeech";
import { setUnit } from "../../src/ui/units";
import type { ResolvedEntity, SnapCandidate } from "../../src/sketch/snap";

afterEach(() => setUnit("mm"));

const ents: ResolvedEntity[] = [
  { type: "line", id: "l1", x1: 0, y1: 0, x2: 4, y2: 0 },
  { type: "line", id: "l2", x1: 12, y1: 3, x2: 20, y2: 9 },
  { type: "rectangle", id: "r1", width: 6, height: 4, x: -10, y: -6 },
  { type: "circle", id: "c1", radius: 2.75, x: 8, y: 9 },
  { type: "arc", id: "a1", x1: 20, y1: 1, x2: 24, y2: 5, mx: 23.5, my: 2.5 },
  { type: "point", id: "p1", x: 5, y: 5 },
  { type: "point", id: "p2", x: 7, y: 8 },
];

const cand = (over: Partial<SnapCandidate>): SnapCandidate => ({
  p: new THREE.Vector2(16, 6),
  kind: "endpoint",
  priority: 100,
  ...over,
});

describe("coordWords", () => {
  it("writes a negative as minus and drops a trailing zero", () => {
    expect(coordWords(5, -7)).toBe("5, minus 7");
    expect(coordWords(20.5, 10)).toBe("20.5, 10");
    expect(coordWords(-3.25, -0.5)).toBe("minus 3.25, minus 0.5");
  });

  it("keeps three decimals at most", () => {
    expect(coordWords(1.23456, -2.00049)).toBe("1.235, minus 2");
  });

  it("does not say minus zero", () => {
    expect(coordWords(-0.0001, 0)).toBe("0, 0");
  });

  it("speaks the display unit", () => {
    setUnit("in");
    expect(coordWords(25.4, -50.8)).toBe("1, minus 2");
    setUnit("cm");
    expect(coordWords(25, -12.5)).toBe("2.5, minus 1.25");
  });
});

describe("snapWords", () => {
  it("names the start and the end of a line or an arc, the middle of a line", () => {
    expect(snapWords(cand({ ref: { entity: "l2", at: 0 } }), ents)).toBe("the start of Line 2");
    expect(snapWords(cand({ ref: { entity: "l2", at: 1 } }), ents)).toBe("the end of Line 2");
    expect(snapWords(cand({ ref: { entity: "a1", at: 1 } }), ents)).toBe("the end of Arc 1");
    expect(snapWords(cand({ kind: "midpoint", ref: { entity: "l2", at: "mid" } }), ents)).toBe(
      "the midpoint of Line 2",
    );
  });

  it("numbers a rectangle corner from one, a circle centre, a placed point", () => {
    expect(snapWords(cand({ ref: { entity: "r1", at: 2 } }), ents)).toBe("corner 3 of Rectangle 1");
    expect(snapWords(cand({ kind: "center", ref: { entity: "c1", at: 0 } }), ents)).toBe("the center of Circle 1");
    expect(snapWords(cand({ ref: { entity: "p2", at: 0 } }), ents)).toBe("Point 2");
  });

  it("falls back to the label without an owner, or when the owner is gone", () => {
    expect(snapWords(cand({ kind: "center", label: "Origin" }), ents)).toBe("the origin");
    expect(snapWords(cand({ kind: "center", label: "Face Center" }), ents)).toBe("the face center");
    expect(snapWords(cand({ kind: "midpoint" }), ents)).toBe("the midpoint");
    expect(snapWords(cand({ kind: "midpoint", ref: { entity: "gone", at: "mid" } }), ents)).toBe("the midpoint");
  });
});

describe("pointSentence", () => {
  it("says the point alone, or with what it snapped to", () => {
    expect(pointSentence({ x: 5, y: -7 }, null, ents)).toBe("Point at 5, minus 7");
    const c = cand({ kind: "midpoint", ref: { entity: "l2", at: "mid" } });
    expect(pointSentence({ x: 16, y: 6 }, c, ents)).toBe("Point at 16, 6, snapped to the midpoint of Line 2");
  });
});
