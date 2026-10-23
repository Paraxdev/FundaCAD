import { describe, expect, it } from "vitest";
import { layoutStack, stackTop } from "../../src/ui/panelStack";
import { SIZE, MARGIN } from "../../src/viewport/viewCube";

describe("the floating panel column", () => {
  it("starts under the view cube's square, inside an area that is offset from the window", () => {
    const area = { left: 37, right: 1411, top: 53, bottom: 902 };
    const top = stackTop(area);
    expect(top).toBeGreaterThan(area.top + MARGIN + SIZE);
    expect(top - (area.top + MARGIN + SIZE)).toBe(12);
  });

  it("opens each panel below the previous one, never on top", () => {
    const panels = [
      { id: "a", height: 210 },
      { id: "b", height: 97 },
      { id: "c", height: 333 },
    ];
    expect(layoutStack(panels, 170, 900)).toEqual([
      { id: "a", top: 170, maxHeight: null },
      { id: "b", top: 392, maxHeight: null },
      { id: "c", top: 501, maxHeight: null },
    ]);
  });

  it("handles none and one", () => {
    expect(layoutStack([], 170, 900)).toEqual([]);
    expect(layoutStack([{ id: "x", height: 41 }], 173, 900)).toEqual([{ id: "x", top: 173, maxHeight: null }]);
  });

  it("moves the others up when one closes", () => {
    const all = [
      { id: "a", height: 210 },
      { id: "b", height: 97 },
      { id: "c", height: 333 },
    ];
    const after = layoutStack(all.filter((p) => p.id !== "b"), 170, 900);
    expect(after).toEqual([
      { id: "a", top: 170, maxHeight: null },
      { id: "c", top: 392, maxHeight: null },
    ]);
  });

  it("keeps a column that exactly fits whole and caps one a pixel over", () => {
    const fit = [
      { id: "a", height: 300 },
      { id: "b", height: 418 },
    ];
    // 170 + 300 + 12 + 418 = 900
    expect(layoutStack(fit, 170, 900).map((s) => s.maxHeight)).toEqual([null, null]);
    expect(layoutStack([fit[0]!, { id: "b", height: 419 }], 170, 900).map((s) => s.maxHeight)).toEqual([null, 418]);
  });

  it("cuts the tall panels first, keeps the short one whole and ends inside the bottom", () => {
    const out = layoutStack(
      [
        { id: "a", height: 900 },
        { id: "b", height: 80 },
        { id: "c", height: 700 },
      ],
      170,
      900,
    );
    expect(out).toEqual([
      { id: "a", top: 170, maxHeight: 313 },
      { id: "b", top: 495, maxHeight: null },
      { id: "c", top: 587, maxHeight: 313 },
    ]);
    expect(587 + 313).toBeLessThanOrEqual(900);
  });

  it("never squeezes a panel below the minimum, letting the column pass the bottom", () => {
    const out = layoutStack(
      [
        { id: "a", height: 500 },
        { id: "b", height: 500 },
        { id: "c", height: 500 },
      ],
      170,
      400,
    );
    expect(out.map((s) => s.maxHeight)).toEqual([120, 120, 120]);
  });
});
