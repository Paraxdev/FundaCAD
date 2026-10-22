// The saved section cut: loose numbers fall back, a bad structure is refused, unknown fields ride along.

import { describe, expect, it } from "vitest";
import { SECTION_GHOSTS, readSectionView, sameSectionView, sectionViewExtras } from "../../src/document/sectionView";
import type { SectionView } from "../../src/types";

const SLANTED: SectionView = {
  origin: [62.5, 18.25, 20],
  normal: [0.6, 0, 0.8],
  offset: -9.5,
  side: -1,
  ghost: "faint",
};

describe("readSectionView", () => {
  it("reads a slanted cut off the origin back whole", () => {
    expect(readSectionView(structuredClone(SLANTED))).toEqual(SLANTED);
  });

  it("makes the normal unit length", () => {
    expect(readSectionView({ ...SLANTED, normal: [3, -4, 12] })).toEqual({
      ...SLANTED,
      normal: [3 / 13, -4 / 13, 12 / 13],
    });
  });

  it("refuses a bad origin", () => {
    for (const origin of [["1", 2, 3], [1, 2], [1, 2, Number.NaN], [1, 2, Infinity], "1,2,3"]) {
      expect(readSectionView({ ...SLANTED, origin })).toBeNull();
    }
  });

  it("refuses a normal of no length, and takes one just past the limit", () => {
    expect(readSectionView({ ...SLANTED, normal: [0, 0, 0] })).toBeNull();
    expect(readSectionView({ ...SLANTED, normal: [0, 1e-12, 0] })).toBeNull();
    expect(readSectionView({ ...SLANTED, normal: [0, 2e-12, 0] })).toEqual({ ...SLANTED, normal: [0, 1, 0] });
    expect(readSectionView({ ...SLANTED, normal: [0.6, 0] })).toBeNull();
  });

  it("refuses what is not one cut", () => {
    for (const raw of [undefined, null, 7, "cut", [SLANTED, SLANTED], { offset: 3 }]) {
      expect(readSectionView(raw)).toBeNull();
    }
  });

  it("falls back for a loose offset, side or ghost", () => {
    const read = (patch: Record<string, unknown>) => readSectionView({ ...SLANTED, ...patch });
    expect(
      [read({ offset: "x" }), read({ offset: Infinity }), read({ offset: undefined })].map((v) => v?.offset),
    ).toEqual([0, 0, 0]);
    expect([0, 2, "-1", -1, 1].map((side) => read({ side })?.side)).toEqual([1, 1, 1, -1, 1]);
    expect(read({ ghost: "fog" })).toEqual({ ...SLANTED, ghost: "soft" });
    expect(SECTION_GHOSTS.map((ghost) => read({ ghost })?.ghost)).toEqual(["hidden", "faint", "soft", "strong"]);
  });

  it("keeps a field a newer version wrote", () => {
    const read = readSectionView({ ...SLANTED, name: "Front", extra: { a: [1, 2] } });
    expect(read).toEqual({ ...SLANTED, name: "Front", extra: { a: [1, 2] } });
    expect(sectionViewExtras(read)).toEqual({ name: "Front", extra: { a: [1, 2] } });
    expect(sectionViewExtras(SLANTED)).toEqual({});
    expect(sectionViewExtras(null)).toEqual({});
  });
});

describe("sameSectionView", () => {
  it("is true only for the same cut, or for no cut on both sides", () => {
    expect(sameSectionView(SLANTED, structuredClone(SLANTED))).toBe(true);
    expect(sameSectionView(null, null)).toBe(true);
    expect(sameSectionView(null, SLANTED)).toBe(false);
    expect(sameSectionView(SLANTED, null)).toBe(false);
    const changed: SectionView[] = [
      { ...SLANTED, origin: [62.5, 18.25, 20.5] },
      { ...SLANTED, normal: [0.8, 0, 0.6] },
      { ...SLANTED, offset: -9.25 },
      { ...SLANTED, side: 1 },
      { ...SLANTED, ghost: "strong" },
    ];
    expect(changed.map((c) => sameSectionView(SLANTED, c))).toEqual([false, false, false, false, false]);
    expect(sameSectionView(SLANTED, { ...SLANTED, name: "Front" } as SectionView)).toBe(true);
  });
});
