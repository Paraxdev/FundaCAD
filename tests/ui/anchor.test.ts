import { describe, expect, it } from "vitest";
import { placeBeside } from "../../src/ui/anchor";

const win = { width: 1000, height: 800 };
const rect = (left: number, top: number, w = 40, h = 40) => ({ left, top, right: left + w, bottom: top + h });

describe("placeBeside", () => {
  it("puts the box on the side asked for, top aligned", () => {
    expect(placeBeside(rect(20, 100), { width: 200, height: 150 }, "right", win)).toEqual({ left: 68, top: 100, side: "right" });
  });

  it("flips to the other side when the asked side runs off the window", () => {
    const p = placeBeside(rect(940, 100), { width: 200, height: 150 }, "right", win);
    expect(p.side).toBe("left");
    expect(p.left).toBe(940 - 8 - 200);
  });

  it("clamps into the window when neither side fits", () => {
    const p = placeBeside(rect(20, 760), { width: 200, height: 300 }, "right", win);
    expect(p.top).toBe(800 - 8 - 300);
    expect(p.left).toBe(68);
  });

  it("centres along the anchor when asked", () => {
    const p = placeBeside(rect(500, 20, 40, 40), { width: 100, height: 50 }, "bottom", win, { align: "center" });
    expect(p).toEqual({ left: 470, top: 68, side: "bottom" });
  });
});
