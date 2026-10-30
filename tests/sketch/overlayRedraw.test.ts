// The viewport renders on demand, so an overlay rebuilt outside a pointer event (an Items eye toggle) only showed
// once the pointer next moved over the viewport.
import { describe, it, expect } from "vitest";
import { SketchOverlay } from "../../src/sketch/overlay";
import type { CadDocument } from "../../src/types";

const doc = (): CadDocument =>
  ({
    version: 4,
    parameters: {},
    features: [
      {
        id: "s1",
        type: "sketch",
        plane: "XY",
        entities: [{ type: "rectangle", id: "a", x: 0, y: 0, width: 10, height: 10 }],
      },
    ],
  }) as unknown as CadDocument;

describe("SketchOverlay.changed", () => {
  it("asks for a frame after every update, also when a sketch was hidden", () => {
    const o = new SketchOverlay();
    let frames = 0;
    o.changed = () => frames++;
    o.update(doc());
    expect(frames).toBe(1);
    o.sketchVisible = () => false;
    o.update(doc());
    expect(frames).toBe(2);
    expect(o.regions).toEqual([]);
  });

  it("is wired to the viewport's render request", async () => {
    const src = (await import("../../src/app/engine.ts?raw")).default;
    expect(src).toMatch(/e\.overlay\.changed = \(\) => e\.viewport\.requestRender\(\);/);
  });
});
