import { describe, it, expect } from "vitest";
import { centreShift, clearRow, promptInsets, type Box } from "../../src/ui/promptPlacement";

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
    expect(promptInsets(AREA, BAND, { left: [box(400, 700, 400, 700)], right: [] }, 12, 200)).toEqual({
      left: 12,
      right: 12,
    });
  });

  it("takes the side from the column, even past the middle", () => {
    const narrow = box(0, 0, 688, 800);
    const sectionView = box(288, 702, 427, 742);
    expect(promptInsets(narrow, BAND, { left: [sectionView], right: [] }, 12, 220)).toEqual({ left: 439, right: 12 });
  });

  it("gives up the right inset first, then the left, to leave the minimum width", () => {
    const left = box(0, 700, 600, 740);
    const right = box(700, 700, 1000, 740);
    expect(promptInsets(AREA, BAND, { left: [left], right: [right] }, 12, 200)).toEqual({ left: 612, right: 188 });
    expect(promptInsets(AREA, BAND, { left: [left], right: [right] }, 12, 500)).toEqual({ left: 488, right: 12 });
  });
});

describe("clearRow", () => {
  // A 1000 by 800 window with Items and History open: the rail's labels and the view controls leave 169px at the top.
  const items = box(12, 50, 275, 790);
  const labels = [
    [50, 447],
    [105, 412],
    [151, 391],
    [197, 397],
    [243, 408],
    [289, 395],
    [335, 390],
    [381, 381],
  ].map(([top, right]) => box(290, top!, right!, top! + 36));
  const lower = box(290, 655, 427, 790);
  const controls = [box(640, 50, 688, 212), box(640, 228, 688, 358), box(640, 372, 688, 603)];
  const history = box(700, 50, 987, 355);
  const cards = { left: [items, ...labels, lower], right: [...controls, history] };

  it("keeps the top row while the box fits there", () => {
    expect(clearRow(AREA, { width: 169, height: 36 }, 52, cards, 12)).toEqual({ top: 52, left: 459, right: 372 });
  });

  it("goes down to the first row with room, past every card that still reaches into it", () => {
    expect(clearRow(AREA, { width: 257, height: 36 }, 52, cards, 12)).toEqual({ top: 429, left: 287, right: 372 });
    expect(clearRow(AREA, { width: 341, height: 36 }, 52, cards, 12)).toEqual({ top: 429, left: 287, right: 372 });
  });

  it("takes a row under the view controls when the box is wider than the room beside them", () => {
    expect(clearRow(AREA, { width: 342, height: 36 }, 52, cards, 12)).toEqual({ top: 615, left: 287, right: 12 });
  });

  it("gives null when no row has room, and when the room is lower than the area", () => {
    expect(clearRow(AREA, { width: 720, height: 36 }, 52, cards, 12)).toBeNull();
    expect(clearRow(box(0, 0, 1000, 476), { width: 257, height: 36 }, 52, cards, 12)).toBeNull();
    expect(clearRow(box(0, 0, 1000, 477), { width: 257, height: 36 }, 52, cards, 12)).toEqual({
      top: 429,
      left: 287,
      right: 372,
    });
  });

  it("is the top row with nothing open", () => {
    expect(clearRow(AREA, { width: 257, height: 36 }, 52, { left: [], right: [] }, 12)).toEqual({
      top: 52,
      left: 12,
      right: 12,
    });
  });
});

describe("centreShift", () => {
  it("slides a prompt the left column pushed right back to the middle of the view", () => {
    // Span 300..988 centres a 400 wide prompt at 444, the view's middle puts it at 300.
    expect(centreShift(1000, { left: 300, right: 12 }, 400)).toBe(-144);
  });

  it("stops where the card begins when the middle would put it under one", () => {
    // The middle would start it at 200, inside the 0..300 card.
    expect(centreShift(1000, { left: 300, right: 12 }, 600)).toBe(-44);
  });

  it("leaves a prompt alone with no card, or one that fills its span", () => {
    expect(centreShift(1000, { left: 12, right: 12 }, 400)).toBe(0);
    expect(centreShift(1000, { left: 300, right: 12 }, 700)).toBe(0);
  });
});
