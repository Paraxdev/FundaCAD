import { describe, expect, it } from "vitest";
import { GUTTER, intersects, placeBubble, ringRect } from "../../../src/ui/guide/placement";

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
