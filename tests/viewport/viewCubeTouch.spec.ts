import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type * as THREE from "three";
import { ViewCube } from "../../src/viewport/viewCube";
import { setPointerKindForTest } from "../../src/input/pointerKind";

// The cube paints its face labels into 2D canvases, which happy-dom does not
// draw; a context that swallows every call is enough to build it.
const realGetContext = HTMLCanvasElement.prototype.getContext;
beforeAll(() => {
  const noop: ProxyHandler<object> = {
    get: (_t, k) => (k === "measureText" ? () => ({ width: 10 }) : () => {}),
    set: () => true,
  };
  HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, noop)) as never;
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

type Pickable = { pick(x: number, y: number): { kind: string } | null };

function cube(): Pickable {
  const canvas = document.createElement("canvas");
  const hooks = { getOverrides: () => ({}), applySide: () => {}, applyDir: () => {} };
  return new ViewCube(canvas, {} as THREE.WebGLRenderer, hooks as never) as unknown as Pickable;
}

describe("view cube pick for a finger", () => {
  afterEach(() => setPointerKindForTest("mouse"));

  it("widens only for touch, and only where the exact pixel misses", () => {
    const vc = cube();
    // A zero sized canvas rect puts the 120 px corner box at left -134, top 14.
    const cx = -134 + 60;
    const cy = 14 + 60;
    const centre = vc.pick(cx, cy);
    expect(centre).not.toBeNull();
    // The first pixel right of centre that a mouse finds nothing at.
    let miss = cx;
    while (vc.pick(miss, cy)) miss++;
    expect(miss - cx).toBeLessThan(60);
    const near = miss + 4;
    expect(vc.pick(near, cy)).toBeNull();

    setPointerKindForTest("touch");
    expect(vc.pick(cx, cy)).toBe(centre);
    expect(vc.pick(near, cy)).not.toBeNull();
    // Beyond the outer ring there is still nothing.
    expect(vc.pick(miss + 20, cy)).toBeNull();
  });
});
