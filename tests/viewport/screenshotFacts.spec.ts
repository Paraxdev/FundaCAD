// A screenshot is what e2e checks read as "the view", so it has to draw the frame
// the loop draws, High stages included.

import { describe, expect, it } from "vitest";
import { Viewport } from "../../src/viewport/viewport";

function bare(ghosted: boolean) {
  const calls: unknown[][] = [];
  const active = { name: "camera" };
  const vp = Object.create(Viewport.prototype) as Viewport;
  Object.assign(vp, {
    scene: { post: { render: (...args: unknown[]) => calls.push(args) } },
    rig: { active },
    canvas: { toDataURL: () => "data:image/png;base64," },
    xray: ghosted,
    wireframe: false,
    stale: false,
    peek: new Set(),
    sketchDimmed: false,
    requestRender: () => {},
  });
  return { vp, calls, active };
}

describe("screenshotPNG", () => {
  it("draws with the facts of a still loop frame", () => {
    for (const ghosted of [false, true]) {
      const b = bare(ghosted);
      expect(b.vp.screenshotPNG()).toBe("data:image/png;base64,");
      expect(b.calls).toEqual([[b.active, false, false, { moving: false, ghosted }]]);
    }
  });
});
