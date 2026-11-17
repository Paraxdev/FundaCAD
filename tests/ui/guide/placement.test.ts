import { describe, expect, it } from "vitest";
import { CAPTION_TOP, GUTTER, intersects, placeBubble, placeCaption, ringRect } from "../../../src/ui/guide/placement";

const view = { width: 1200, height: 800 };
const size = { width: 260, height: 120 };

describe("placeBubble", () => {
  it("sits right of a rail button", () => {
    const btn = { left: 8, top: 200, width: 40, height: 40 };
    const b = placeBubble(btn, view, size);
    expect(b.side).toBe("right");
    expect(b.left).toBeGreaterThan(btn.left + btn.width);
    expect(intersects(b, ringRect(btn))).toBe(false);
  });

  it("flips left at the right edge", () => {
    const btn = { left: 1150, top: 300, width: 40, height: 40 };
    expect(placeBubble(btn, view, size).side).toBe("left");
  });

  it("goes below a title bar menu that spans the width", () => {
    const bar = { left: 0, top: 0, width: 1200, height: 32 };
    const b = placeBubble(bar, view, size);
    expect(b.side).toBe("below");
    expect(b.top).toBeGreaterThan(32);
  });

  it("stays inside the 16 px gutter", () => {
    const corner = { left: 20, top: 2, width: 30, height: 20 };
    const b = placeBubble(corner, view, size);
    expect(b.top).toBeGreaterThanOrEqual(GUTTER);
    expect(b.left).toBeGreaterThanOrEqual(GUTTER);
    expect(b.left + b.width).toBeLessThanOrEqual(view.width - GUTTER);
  });

  it("never covers an open dialog it was told to avoid", () => {
    const btn = { left: 8, top: 200, width: 40, height: 40 };
    const dialog = { left: 60, top: 150, width: 400, height: 100 };
    const b = placeBubble(btn, view, size, [dialog]);
    expect(intersects(b, dialog)).toBe(false);
    expect(intersects(b, ringRect(btn))).toBe(false);
  });

  it("follows a target that moved", () => {
    const a = placeBubble({ left: 100, top: 100, width: 40, height: 40 }, view, size);
    const b = placeBubble({ left: 100, top: 400, width: 40, height: 40 }, view, size);
    expect(b.top - a.top).toBe(300);
  });

  it("inflates the ring by 4 px", () => {
    expect(ringRect({ left: 10, top: 10, width: 20, height: 20 })).toEqual({ left: 6, top: 6, width: 28, height: 28 });
  });
});

describe("placeCaption", () => {
  it("sits at the top centre with nothing in the way", () => {
    expect(placeCaption(view, size)).toEqual({ side: "below", left: 470, top: CAPTION_TOP, ...size });
  });

  it("stays at the top centre beside a sketch that does not reach it", () => {
    const work = { left: 560, top: 400, width: 200, height: 200 };
    expect(placeCaption(view, size, [], { work })).toEqual({ side: "below", left: 470, top: CAPTION_TOP, ...size });
  });

  // The shell of a 1400x900 and a 1280x720 window in sketch mode, and the first 50 mm square of a sketch on XZ.
  const shell = (w: number, h: number) => ({
    view: { width: w, height: h },
    chrome: [
      { left: 12, top: 48, width: 264, height: h - 60 },
      { left: 288, top: 48, width: 155, height: h - 60 },
      { left: w - 312, top: 48, width: 48, height: h - 60 },
      { left: w - 250, top: 48, width: 237, height: Math.min(660, h - 60) },
      { left: w / 2 - 183, top: h - 90, width: 366, height: 40 },
      { left: w - 415, top: 50, width: 90, height: 90 },
    ],
  });
  const bubble = { width: 280, height: 163 };

  it.each([
    [1400, 900, { left: 700, top: 157, width: 310, height: 310 }],
    [1280, 720, { left: 640, top: 130, width: 248, height: 248 }],
  ])("keeps off a sketch over the top centre at %ix%i, and off the rail, cards, view cube and prompt", (w, h, work) => {
    const { view: v, chrome } = shell(w, h);
    const b = placeCaption(v, bubble, [], { work, chrome });
    expect(intersects(b, ringRect(work))).toBe(false);
    expect(chrome.filter((c) => intersects(b, c))).toEqual([]);
    expect(b.top + b.height).toBeLessThanOrEqual(h - GUTTER);
  });

  it("covers the shell rather than the sketch when nothing else is clear", () => {
    const work = { left: 300, top: 60, width: 600, height: 500 };
    const chrome = [{ left: 0, top: 0, width: 1200, height: 800 }];
    const b = placeCaption(view, size, [], { work, chrome });
    expect(intersects(b, ringRect(work))).toBe(false);
  });

  it("never covers a dialog to keep off a sketch", () => {
    const work = { left: 400, top: 60, width: 400, height: 300 };
    const dialog = { left: 300, top: 360, width: 600, height: 400 };
    const b = placeCaption(view, size, [dialog], { work });
    expect([intersects(b, dialog), intersects(b, ringRect(work))]).toEqual([false, false]);
  });

  it("moves beside a dialog that covers the top centre, never over it", () => {
    const dialog = { left: 400, top: 40, width: 400, height: 500 };
    const b = placeCaption(view, size, [dialog]);
    expect(intersects(b, dialog)).toBe(false);
    expect(b.left).toBeGreaterThanOrEqual(GUTTER);
    expect(b.left + b.width).toBeLessThanOrEqual(view.width - GUTTER);
  });
});
