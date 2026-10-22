import { describe, expect, it } from "vitest";
import { placeBeside } from "../../src/sketch/dimInput";

const bounds = { left: 288, top: 0, right: 1028, bottom: 900 };
const size = { w: 556, h: 41 };

describe("placeBeside", () => {
  it("goes past the model's right side when it fits there", () => {
    const model = { left: 300, top: 300, right: 400, bottom: 500 };
    expect(placeBeside(model, { x: 350, y: 400 }, size, { ...bounds, right: 1400 }, 8)).toEqual({
      left: 408,
      top: 379.5,
    });
  });

  it("goes to the left side when the right one is cut off", () => {
    const model = { left: 900, top: 300, right: 1000, bottom: 500 };
    const at = placeBeside(model, { x: 950, y: 400 }, size, { ...bounds, right: 1400 }, 8);
    expect(at.left + size.w).toBeLessThanOrEqual(model.left);
    expect(at.left).toBeGreaterThanOrEqual(288);
  });

  it("goes above a model that fills the width, as at 1400 px, and stays inside the bounds", () => {
    const model = { left: 397, top: 313, right: 1090, bottom: 727 };
    const at = placeBeside(model, { x: 700, y: 433 }, size, bounds, 8);
    expect(at).toEqual({ left: 422, top: 264 });
    expect(at.left + size.w).toBeLessThanOrEqual(bounds.right);
  });

  it("is clamped into the bounds when nowhere beside the model fits", () => {
    const model = { left: 300, top: 5, right: 1000, bottom: 895 };
    const at = placeBeside(model, { x: 650, y: 450 }, size, bounds, 8);
    expect(at.left).toBeGreaterThanOrEqual(bounds.left);
    expect(at.left + size.w).toBeLessThanOrEqual(bounds.right);
  });
});
