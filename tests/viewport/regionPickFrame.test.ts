// Hover draws only on a pointer move, so a Ctrl-click on a sketch area under a still cursor stayed unlit until the
// cursor moved.
import { describe, expect, it } from "vitest";
import { Viewport } from "../../src/viewport/viewport";

describe("a click that picks a sketch area", () => {
  it("asks for a frame, with Ctrl or without", () => {
    for (const ctrl of [false, true]) {
      let frames = 0;
      const vp = Object.create(Viewport.prototype) as Viewport;
      Object.assign(vp, {
        canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
        selectPolicy: "faces",
        selectionMode: "faces",
        model: null,
        regionPickAt: () => true,
        requestRender: () => frames++,
      });
      (vp as unknown as { clickAt(x: number, y: number, c: boolean, s: boolean): void }).clickAt(50, 50, ctrl, false);
      expect(frames).toBe(1);
    }
  });
});
