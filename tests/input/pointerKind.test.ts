import { afterEach, describe, expect, it } from "vitest";
import { hitPx, hitScale, pointerKind, setPointerKindForTest, TOUCH_HIT_SCALE } from "../../src/input/pointerKind";

describe("pointer kind hit sizing", () => {
  afterEach(() => setPointerKindForTest("mouse"));

  it("leaves every tolerance alone for a mouse", () => {
    setPointerKindForTest("mouse");
    expect(pointerKind()).toBe("mouse");
    expect(hitScale()).toBe(1);
    expect(hitPx(13)).toBe(13);
    expect(hitPx(0.75)).toBe(0.75);
  });

  it("treats a pen as precise as a mouse", () => {
    setPointerKindForTest("pen");
    expect(hitScale()).toBe(1);
    expect(hitPx(9)).toBe(9);
  });

  it("grows tolerances for a finger", () => {
    setPointerKindForTest("touch");
    expect(hitScale()).toBe(TOUCH_HIT_SCALE);
    expect(TOUCH_HIT_SCALE).toBeGreaterThan(1);
    expect(hitPx(10)).toBe(10 * TOUCH_HIT_SCALE);
  });

  it("follows the kind back to the mouse", () => {
    setPointerKindForTest("touch");
    setPointerKindForTest("mouse");
    expect(hitPx(8)).toBe(8);
  });
});
