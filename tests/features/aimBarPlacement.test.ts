import { describe, expect, it } from "vitest";
import { stalkReach } from "../../src/features/lightAimTool";
import { placeBeside } from "../../src/sketch/dimInput";

describe("the Aim bar beside the stalk", () => {
  const bar = { w: 150, h: 40 };
  const area = { left: 0, right: 1000, top: 0, bottom: 700 };

  it("sits to the right of the stalk when there is room", () => {
    const foot = { x: 300, y: 250 };
    const at = placeBeside(stalkReach(foot), foot, bar, area);
    expect(at.left).toBeGreaterThanOrEqual(foot.x + 88);
  });

  it("stays left of a right card instead of running under it", () => {
    const foot = { x: 700, y: 250 };
    const free = { ...area, right: 900 };
    const at = placeBeside(stalkReach(foot), foot, bar, free);
    expect(at.left + bar.w).toBeLessThanOrEqual(900);
    expect(at.left + bar.w).toBeGreaterThan(0);
    expect(placeBeside(stalkReach(foot), foot, bar, area).left + bar.w).toBeGreaterThan(900);
  });
});
