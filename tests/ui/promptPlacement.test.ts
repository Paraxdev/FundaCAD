import { describe, it, expect } from "vitest";
import { promptInsets, type Box } from "../../src/ui/promptPlacement";

const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
const AREA = box(0, 0, 1000, 800);
const BAND = { top: 700, bottom: 750 };

describe("promptInsets", () => {
  it("keeps just the gap when nothing is in the row", () => {
    expect(promptInsets(AREA, BAND, { left: [], right: [] }, 12, 200)).toEqual({ left: 12, right: 12 });
  });

  it("clears a column on each side by the gap", () => {
    const rail = box(290, 690, 430, 740);
    const card = box(800, 600, 988, 760);
    expect(promptInsets(AREA, BAND, { left: [rail], right: [card] }, 12, 200)).toEqual({ left: 442, right: 212 });
  });

  it("ignores a card that ends above the row", () => {
    const history = box(700, 12, 988, 300);
    expect(promptInsets(AREA, BAND, { left: [], right: [history] }, 12, 200)).toEqual({ left: 12, right: 12 });
  });

  it("measures from the area, not the window", () => {
    const area = box(100, 0, 900, 800);
    const items = box(12, 12, 300, 788);
    expect(promptInsets(area, BAND, { left: [items], right: [] }, 12, 200)).toEqual({ left: 212, right: 12 });
  });

  it("ignores an empty box, a hidden card", () => {
    expect(promptInsets(AREA, BAND, { left: [box(400, 700, 400, 700)], right: [] }, 12, 200))
      .toEqual({ left: 12, right: 12 });
  });

  it("takes the side from the column, even past the middle", () => {
    const narrow = box(0, 0, 688, 800);
    const sectionView = box(288, 702, 427, 742);
    expect(promptInsets(narrow, BAND, { left: [sectionView], right: [] }, 12, 220))
      .toEqual({ left: 439, right: 12 });
  });

  it("gives up the right inset first, then the left, to leave the minimum width", () => {
    const left = box(0, 700, 600, 740);
    const right = box(700, 700, 1000, 740);
    expect(promptInsets(AREA, BAND, { left: [left], right: [right] }, 12, 200)).toEqual({ left: 612, right: 188 });
    expect(promptInsets(AREA, BAND, { left: [left], right: [right] }, 12, 500)).toEqual({ left: 488, right: 12 });
  });
});
