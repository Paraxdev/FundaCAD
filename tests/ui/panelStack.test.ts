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
    const after = layoutStack(
      all.filter((p) => p.id !== "b"),
      170,
      900,
    );
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

  // The 1440x700 case: Properties, Interference, then Stress whose step scrolls inside it.
  const three = [
    { id: "properties", height: 326, head: 50 },
    { id: "interference", height: 138, head: 50 },
    { id: "stress", height: 657, head: 58, floor: 301 },
  ];

  it("keeps a panel's floor and folds the oldest panel to its header when the floors do not fit", () => {
    const out = layoutStack(three, 182, 686);
    expect(out).toEqual([
      { id: "properties", top: 182, maxHeight: 50, folded: true },
      { id: "interference", top: 244, maxHeight: 129 },
      { id: "stress", top: 385, maxHeight: 301 },
    ]);
    expect(385 + 301).toBeLessThanOrEqual(686);
  });

  it("folds nothing while the floors still fit, one pixel either side", () => {
    // 120 + 120 + 301 + 2 gaps of 12 = 565
    expect(layoutStack(three, 0, 565).some((s) => s.folded)).toBe(false);
    expect(layoutStack(three, 0, 564).map((s) => !!s.folded)).toEqual([true, false, false]);
  });

  it("folds the least recently used panel, never the most recent one", () => {
    const used = three.map((p, i) => ({ ...p, rank: [9, 1, 5][i]! }));
    expect(layoutStack(used, 182, 686).map((s) => !!s.folded)).toEqual([false, true, false]);
    const tiny = layoutStack(three, 182, 400);
    expect(tiny.map((s) => !!s.folded)).toEqual([true, true, false]);
    expect(tiny[2]!.maxHeight).toBe(301);
  });

  it("gives a floor above the minimum before cutting the others to theirs", () => {
    const out = layoutStack(
      [
        { id: "a", height: 400 },
        { id: "b", height: 600, floor: 300 },
      ],
      0,
      512,
    );
    expect(out.map((s) => s.maxHeight)).toEqual([200, 300]);
  });
});
